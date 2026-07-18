import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dailySchedulerReceiptPath,
  inspectDailyScheduler,
  installDailyScheduler,
  quoteWindowsCommandLineArgument,
  type DailySchedulerOptions,
  type DailySchedulerPlatform,
  type SchedulerCommandResult,
} from "../src/install/daily-scheduler";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  options: DailySchedulerOptions;
  commands: string[][];
  nativePresent: boolean;
  failVerification: boolean;
  inspectionCount: number;
  failInspectionAt?: number;
}

function executable(path: string): string {
  writeFileSync(path, "controlled executable\n");
  chmodSync(path, 0o700);
  return path;
}

function harness(platform: DailySchedulerPlatform): Harness {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", `vibebloat-scheduler-${platform}-`));
  roots.push(root);
  const home = join(root, "vibebloat");
  const userHome = join(root, "user");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(userHome);
  mkdirSync(bin);
  const app = executable(join(bin, platform === "win32" ? "vibebloat.exe" : "vibebloat"));
  const nativeExecutables: Record<string, string> = {};
  for (const name of ["powershell", "schtasks", "launchctl", "systemctl"] as const) {
    nativeExecutables[name] = executable(join(bin, platform === "win32" ? `${name}.exe` : name));
  }
  const state: Harness = {
    commands: [],
    nativePresent: false,
    failVerification: false,
    inspectionCount: 0,
    options: undefined as unknown as DailySchedulerOptions,
  };
  const runner = (command: readonly string[]): SchedulerCommandResult => {
    state.commands.push([...command]);
    const arguments_ = command.slice(1);
    if (platform === "win32") {
      if (command[0] === nativeExecutables.powershell) {
        state.inspectionCount += 1;
        if (state.failInspectionAt === state.inspectionCount) return { exitCode: 2, stderr: "injected inspection failure" };
        if (!state.nativePresent) return { exitCode: 3 };
        const json = Buffer.from(JSON.stringify({
          execute: app,
          arguments: "daily",
          enabled: true,
          daysInterval: 1,
          triggerEnabled: true,
          hour: state.failVerification ? 4 : 3,
          minute: 0,
        }), "utf16le");
        return { exitCode: 0, stdout: Buffer.concat([Buffer.from([0xff, 0xfe]), json]) };
      }
      if (arguments_[0] === "/Create") {
        expect(existsSync(dailySchedulerReceiptPath(home))).toBe(false);
        state.nativePresent = true;
        return { exitCode: 0 };
      }
      if (arguments_[0] === "/Delete") {
        state.nativePresent = false;
        return { exitCode: 0 };
      }
    }
    if (platform === "darwin") {
      if (arguments_[0] === "print") {
        state.inspectionCount += 1;
        if (state.failInspectionAt === state.inspectionCount) return { exitCode: 2, stderr: "injected inspection failure" };
        if (!state.nativePresent) return { exitCode: 113 };
        return {
          exitCode: 0,
          stdout: `program = ${app}\narguments = {\n  0 = ${app}\n  1 = daily\n}\nevent triggers = {\n  com.apple.launchd.calendarinterval = {\n    Hour => 3\n    Minute => ${state.failVerification ? 30 : 0}\n  }\n}\n`,
        };
      }
      if (arguments_[0] === "bootstrap") {
        expect(existsSync(dailySchedulerReceiptPath(home))).toBe(false);
        state.nativePresent = true;
        return { exitCode: 0 };
      }
      if (arguments_[0] === "bootout") {
        state.nativePresent = false;
        return { exitCode: 0 };
      }
    }
    if (platform === "linux") {
      if (arguments_[0] === "--user" && arguments_[1] === "show") {
        if (arguments_[2] === "vibebloat-daily.timer") {
          state.inspectionCount += 1;
          if (state.failInspectionAt === state.inspectionCount) return { exitCode: 2, stderr: "injected inspection failure" };
        }
        if (!state.nativePresent) return { exitCode: 0, stdout: "LoadState=not-found\n" };
        const unit = arguments_[2];
        const unitRoot = join(userHome, ".config", "systemd", "user");
        if (unit === "vibebloat-daily.timer") {
          return {
            exitCode: 0,
            stdout: state.failVerification
              ? `LoadState=loaded\nFragmentPath=${join(root, "foreign.timer")}\nUnitFileState=enabled\nActiveState=active\n`
              : `LoadState=loaded\nFragmentPath=${join(unitRoot, unit)}\nUnitFileState=enabled\nActiveState=active\n`,
          };
        }
        return { exitCode: 0, stdout: `LoadState=loaded\nFragmentPath=${join(unitRoot, "vibebloat-daily.service")}\n` };
      }
      if (arguments_.includes("enable")) {
        expect(existsSync(dailySchedulerReceiptPath(home))).toBe(false);
        state.nativePresent = true;
        return { exitCode: 0 };
      }
      if (arguments_.includes("disable")) {
        state.nativePresent = false;
        return { exitCode: 0 };
      }
      if (arguments_.includes("daemon-reload")) return { exitCode: 0 };
    }
    return { exitCode: 99, stderr: "unexpected test command" };
  };
  state.options = {
    home,
    userHome,
    executable: app,
    trustedExecutableRoot: bin,
    platform,
    uid: 501,
    now: new Date(),
    runner,
    nativeExecutables,
  };
  return state;
}

test.each(["win32", "darwin", "linux"] as const)("installs and re-verifies %s daily scheduler", (platform) => {
  const state = harness(platform);
  const receipt = installDailyScheduler(state.options);

  expect(receipt.platform).toBe(platform);
  expect(receipt.command.slice(1)).toEqual(["daily"]);
  expect(receipt.commandSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.configSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.executableSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(inspectDailyScheduler(state.options)).toBe("healthy");
  expect(installDailyScheduler(state.options)).toEqual(receipt);

  if (platform === "win32") {
    const create = state.commands.find((command) => command[1] === "/Create")!;
    expect(create).toContain("\\VibeBloat\\Daily");
    expect(create[create.indexOf("/TR") + 1]).toBe(`${quoteWindowsCommandLineArgument(receipt.command[0])} daily`);
    expect(create).not.toContain("/F");
  } else if (platform === "darwin") {
    expect(state.commands.some((command) => command[1] === "bootstrap" && command[2] === "gui/501")).toBe(true);
    expect(state.commands.some((command) => command[1] === "print" && command[2] === "gui/501/dev.vibebloat.daily")).toBe(true);
  } else {
    expect(receipt.configPaths).toEqual([
      join(state.options.userHome, ".config", "systemd", "user", "vibebloat-daily.service"),
      join(state.options.userHome, ".config", "systemd", "user", "vibebloat-daily.timer"),
    ]);
    expect(state.commands.some((command) => command.includes("enable") && command.includes("--now"))).toBe(true);
  }
});

test("Windows command-line quoting preserves empty, quoted, and trailing-backslash arguments", () => {
  expect(quoteWindowsCommandLineArgument("")).toBe('""');
  expect(quoteWindowsCommandLineArgument("plain")).toBe("plain");
  expect(quoteWindowsCommandLineArgument("two words")).toBe('"two words"');
  expect(quoteWindowsCommandLineArgument('say "hi"')).toBe('"say \\\"hi\\\""');
  expect(quoteWindowsCommandLineArgument("C:\\Program Files\\")).toBe('"C:\\Program Files\\\\"');
  expect(() => quoteWindowsCommandLineArgument("bad\narg")).toThrow("control characters");
});

test.each(["win32", "darwin", "linux"] as const)("rolls back %s native and file state when post-install verification fails", (platform) => {
  const state = harness(platform);
  state.failInspectionAt = 3;

  expect(() => installDailyScheduler(state.options)).toThrow("inspection failed");
  expect(state.nativePresent).toBe(false);
  expect(existsSync(dailySchedulerReceiptPath(state.options.home))).toBe(false);
  if (platform === "win32") expect(existsSync(join(state.options.home, "scheduler", "windows-daily.json"))).toBe(false);
  else if (platform === "darwin") {
    expect(existsSync(join(state.options.userHome, "Library", "LaunchAgents", "dev.vibebloat.daily.plist"))).toBe(false);
    expect(state.commands.some((command) => command[1] === "bootout" && command[2] === "gui/501/dev.vibebloat.daily")).toBe(true);
  }
  else {
    expect(existsSync(join(state.options.userHome, ".config", "systemd", "user", "vibebloat-daily.service"))).toBe(false);
    expect(existsSync(join(state.options.userHome, ".config", "systemd", "user", "vibebloat-daily.timer"))).toBe(false);
  }
});

test("preserves mismatched native state instead of deleting unverified target", () => {
  const state = harness("win32");
  state.failVerification = true;

  expect(() => installDailyScheduler(state.options)).toThrow("rollback was incomplete");
  expect(state.nativePresent).toBe(true);
  expect(state.commands.some((command) => command[1] === "/Delete")).toBe(false);
  expect(existsSync(dailySchedulerReceiptPath(state.options.home))).toBe(false);
});

test("rejects junction descendants before reading or mutating scheduler state", () => {
  const state = harness("linux");
  const outside = join(dirnameFor(state.options.userHome), "outside-config");
  mkdirSync(outside);
  const config = join(state.options.userHome, ".config");
  symlinkSync(outside, config, "junction");

  expect(() => installDailyScheduler(state.options)).toThrow("symbolic link or junction");
  expect(state.commands).toHaveLength(0);
});

test("refuses unreceipted native or local scheduler state", () => {
  const native = harness("win32");
  native.nativePresent = true;
  expect(() => installDailyScheduler(native.options)).toThrow("already occupied");
  expect(native.commands.some((command) => command[1] === "/Create")).toBe(false);

  const local = harness("linux");
  const unit = join(local.options.userHome, ".config", "systemd", "user", "vibebloat-daily.timer");
  mkdirSync(join(local.options.userHome, ".config", "systemd", "user"), { recursive: true });
  writeFileSync(unit, "foreign\n");
  expect(() => installDailyScheduler(local.options)).toThrow("without a verified receipt");
  expect(local.commands).toHaveLength(0);
});

test("refuses malformed prior receipt before any native mutation", () => {
  const state = harness("win32");
  const receiptPath = dailySchedulerReceiptPath(state.options.home);
  mkdirSync(join(state.options.home, "receipts"));
  writeFileSync(receiptPath, "not-json\n");

  expect(() => installDailyScheduler(state.options)).toThrow("receipt is malformed");
  expect(state.commands).toHaveLength(0);
});

test("receipt verifier detects config, executable, timestamp, and native drift", () => {
  const config = harness("linux");
  const receipt = installDailyScheduler(config.options);
  writeFileSync(receipt.configPaths[0], "tampered\n");
  expect(inspectDailyScheduler(config.options)).toBe("unhealthy");

  const binary = harness("win32");
  installDailyScheduler(binary.options);
  writeFileSync(binary.options.executable, "tampered executable\n");
  expect(inspectDailyScheduler(binary.options)).toBe("unhealthy");

  const timestamp = harness("darwin");
  installDailyScheduler(timestamp.options);
  const timestampPath = dailySchedulerReceiptPath(timestamp.options.home);
  const parsed = JSON.parse(readFileSync(timestampPath, "utf8"));
  parsed.installedAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  writeFileSync(timestampPath, `${JSON.stringify(parsed)}\n`);
  expect(inspectDailyScheduler(timestamp.options)).toBe("unhealthy");

  const native = harness("linux");
  installDailyScheduler(native.options);
  native.failVerification = true;
  expect(inspectDailyScheduler(native.options)).toBe("unhealthy");
});

test.each(["win32", "darwin"] as const)("receipt verifier detects %s daily trigger drift", (platform) => {
  const state = harness(platform);
  installDailyScheduler(state.options);
  state.failVerification = true;
  expect(inspectDailyScheduler(state.options)).toBe("unhealthy");
});

test("rejects writable executable and symlinked scheduler executable", () => {
  if (process.platform !== "win32") {
    const writable = harness("linux");
    chmodSync(writable.options.executable, 0o722);
    expect(() => installDailyScheduler(writable.options)).toThrow("group- or world-writable");
  }

  const linked = harness("win32");
  const real = linked.options.executable;
  const link = join(linked.options.trustedExecutableRoot, "linked.exe");
  symlinkSync(real, link, "file");
  expect(() => installDailyScheduler({ ...linked.options, executable: link })).toThrow("symbolic link or junction");
});

function dirnameFor(path: string): string {
  return join(path, "..");
}
