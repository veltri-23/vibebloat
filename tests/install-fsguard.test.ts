import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfigWrongFileGuard } from "../src/guards";
import { closeWatcherOnSignals, evaluateFsWrite, fsGuardReceiptPath, fsGuardStopRequestPath, hasUnenforceableFileGuard, inspectPersistentFsGuard, launchPersistentFsGuard, stopPersistentFsGuard, waitForFsGuardLaunchReceipt, watchFsGuardStopRequests, watchGuardedWrites } from "../src/install/fs-guard";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("filesystem guard evaluation identifies wrong MCP config writes", () => {
  expect(evaluateFsWrite([mcpConfigWrongFileGuard], "C:/repo/.mcp.json")).toMatchObject({ exitCode: 2 });
});

test("filesystem watcher identifies file guards that require post-write recovery", () => {
  expect(hasUnenforceableFileGuard([mcpConfigWrongFileGuard])).toBe(true);
  const watcher = watchGuardedWrites(import.meta.dir, [mcpConfigWrongFileGuard], () => {});
  watcher.close();
});

test("filesystem watcher quarantines a guarded new file after the filesystem event", async () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-guard-"));
  temporaryDirectories.push(directory);

  const response = await new Promise<{ path: string; exitCode: number }>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const watcher = watchGuardedWrites(directory, [mcpConfigWrongFileGuard], (path, detected) => {
      watcher.close();
      clearTimeout(timeout);
      resolve({ path, exitCode: detected.exitCode });
    });
    timeout = setTimeout(() => {
      watcher.close();
      reject(new Error("fs.watch did not report the guarded write"));
    }, 1_000);
    writeFileSync(join(directory, ".mcp.json"), "{}");
  });

  expect(response).toEqual({ path: ".mcp.json", exitCode: 2 });
  expect(existsSync(join(directory, ".mcp.json"))).toBeFalse();
  const quarantineDirectory = join(directory, ".vibebloat", "quarantine", "fs-guard");
  const quarantine = readdirSync(quarantineDirectory).find((entry) => entry.startsWith(".mcp.json.") && entry.endsWith(".rejected"));
  expect(quarantine).toBeTruthy();
  expect(readFileSync(join(quarantineDirectory, quarantine!), "utf8")).toBe("{}");
});

test("filesystem watcher restores the previous guarded file without losing the rejected write", async () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-restore-"));
  temporaryDirectories.push(directory);
  const target = join(directory, ".mcp.json");
  writeFileSync(target, "trusted\n");

  await new Promise<void>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;
    const watcher = watchGuardedWrites(directory, [mcpConfigWrongFileGuard], () => {
      watcher.close();
      clearTimeout(timeout);
      resolve();
    });
    timeout = setTimeout(() => {
      watcher.close();
      reject(new Error("fs.watch did not recover the guarded write"));
    }, 1_000);
    writeFileSync(target, "rejected\n");
  });

  expect(readFileSync(target, "utf8")).toBe("trusted\n");
  const quarantineDirectory = join(directory, ".vibebloat", "quarantine", "fs-guard");
  const quarantine = readdirSync(quarantineDirectory).find((entry) => entry.startsWith(".mcp.json.") && entry.endsWith(".rejected"));
  expect(quarantine).toBeTruthy();
  expect(readFileSync(join(quarantineDirectory, quarantine!), "utf8")).toBe("rejected\n");
});

test("filesystem watcher recovers a second rejected write during its own callback", async () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-rapid-"));
  temporaryDirectories.push(directory);
  const target = join(directory, ".mcp.json");
  writeFileSync(target, "trusted\n");

  await new Promise<void>((resolve, reject) => {
    let detections = 0;
    let timeout: ReturnType<typeof setTimeout>;
    const watcher = watchGuardedWrites(directory, [mcpConfigWrongFileGuard], () => {
      detections += 1;
      if (detections === 1) writeFileSync(target, "second-rejected\n");
      if (detections === 2) {
        watcher.close();
        clearTimeout(timeout);
        resolve();
      }
    });
    timeout = setTimeout(() => {
      watcher.close();
      reject(new Error("fs.watch did not recover both guarded writes"));
    }, 1_000);
    writeFileSync(target, "first-rejected\n");
  });

  expect(readFileSync(target, "utf8")).toBe("trusted\n");
  const quarantineDirectory = join(directory, ".vibebloat", "quarantine", "fs-guard");
  const rejected = readdirSync(quarantineDirectory)
    .filter((entry) => entry.startsWith(".mcp.json.") && entry.endsWith(".rejected"))
    .map((entry) => readFileSync(join(quarantineDirectory, entry), "utf8"))
    .sort();
  expect(rejected).toEqual(["first-rejected\n", "second-rejected\n"]);
});

test("filesystem watcher closes once when signaled", () => {
  const listeners = new Map<string, () => void>();
  const signals = {
    once: (signal: string, listener: () => void) => listeners.set(signal, listener),
    off: (signal: string) => listeners.delete(signal),
  };
  let closes = 0;
  let completed = 0;
  const close = closeWatcherOnSignals({ close: () => { closes += 1; } }, signals, () => { completed += 1; });

  expect([...listeners.keys()]).toEqual(["SIGINT", "SIGTERM"]);
  listeners.get("SIGINT")?.();
  close();

  expect({ closes, completed, listenerCount: listeners.size }).toEqual({ closes: 1, completed: 1, listenerCount: 0 });
});

test("persistent filesystem guard launch writes an owned receipt and is idempotent while alive", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-launch-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  let spawns = 0;
  let unrefs = 0;
  let spawnedCommand: readonly string[] = [];
  const spawn = (childCommand: readonly string[]) => {
    spawns += 1;
    spawnedCommand = childCommand;
    return { pid: 4242, unref: () => { unrefs += 1; }, kill: () => {} };
  };

  const first = launchPersistentFsGuard({ directory, command, spawn, probeProcess: () => "owned", now: new Date("2026-07-18T12:00:00Z") });
  const second = launchPersistentFsGuard({ directory, command, spawn, probeProcess: () => "owned" });

  expect(second).toEqual(first);
  expect({ spawns, unrefs }).toEqual({ spawns: 1, unrefs: 1 });
  expect(spawnedCommand).toContain(`--vibebloat-fs-guard-instance=${first.instanceId}`);
  expect(spawnedCommand).toContain(`--vibebloat-fs-guard-receipt=${fsGuardReceiptPath(directory)}`);
  expect(JSON.parse(readFileSync(fsGuardReceiptPath(directory), "utf8"))).toEqual(first);
});

test("persistent filesystem guard health requires an owned live process", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-health-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];

  expect(inspectPersistentFsGuard({ directory })).toBe("absent");
  launchPersistentFsGuard({
    directory,
    command,
    spawn: () => ({ pid: 4242, unref: () => {}, kill: () => {} }),
    probeProcess: () => "owned",
  });
  expect(inspectPersistentFsGuard({ directory, probeProcess: () => "owned" })).toBe("healthy");
  expect(inspectPersistentFsGuard({ directory, probeProcess: () => "missing" })).toBe("unhealthy");
});

test("persistent filesystem guard replaces a stale owned receipt", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-launch-"));
  temporaryDirectories.push(directory);
  const receiptPath = fsGuardReceiptPath(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 41, unref: () => {}, kill: () => {} }), probeProcess: () => "owned" });
  const receipt = launchPersistentFsGuard({
    directory,
    command,
    spawn: () => ({ pid: 42, unref: () => {}, kill: () => {} }),
    probeProcess: (pid) => pid === 41 ? "missing" : "owned",
  });
  expect(receipt.pid).toBe(42);
  expect(JSON.parse(readFileSync(receiptPath, "utf8")).pid).toBe(42);
});

test("persistent filesystem guard refuses malformed or external receipts before spawning", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-launch-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  const receiptPath = fsGuardReceiptPath(directory);
  mkdirSync(join(directory, ".vibebloat", "receipts"), { recursive: true });
  writeFileSync(receiptPath, "{}", { flag: "w" });
  let spawns = 0;
  const spawn = () => { spawns += 1; return { pid: 1, unref: () => {}, kill: () => {} }; };

  expect(() => launchPersistentFsGuard({ directory, command, spawn })).toThrow("not VibeBloat-owned");
  expect(() => launchPersistentFsGuard({ directory, receiptPath: join(directory, "host.json"), command, spawn })).toThrow("inside the repository .vibebloat");
  expect(spawns).toBe(0);
});

test("persistent filesystem guard rejects symlinked receipt parents and invalid clocks before spawning", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-launch-"));
  const outside = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-outside-"));
  temporaryDirectories.push(directory, outside);
  mkdirSync(join(directory, ".vibebloat"));
  symlinkSync(outside, join(directory, ".vibebloat", "receipts"), "junction");
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  let spawns = 0;
  const spawn = () => { spawns += 1; return { pid: 1, unref: () => {}, kill: () => {} }; };

  expect(() => launchPersistentFsGuard({ directory, command, spawn })).toThrow("parent cannot be a symbolic link");
  const clockDirectory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-clock-"));
  temporaryDirectories.push(clockDirectory);
  const clockCommand = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", clockDirectory];
  expect(() => launchPersistentFsGuard({ directory: clockDirectory, command: clockCommand, spawn, now: new Date("invalid") })).toThrow("clock is invalid");
  expect(spawns).toBe(0);
});

test("persistent filesystem guard refuses a live foreign PID before spawning", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-foreign-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 51, unref: () => {}, kill: () => {} }), probeProcess: () => "owned" });
  let spawns = 0;

  expect(() => launchPersistentFsGuard({
    directory,
    command,
    spawn: () => { spawns += 1; return { pid: 52, unref: () => {}, kill: () => {} }; },
    probeProcess: () => "foreign",
  })).toThrow("belongs to another process");
  expect(spawns).toBe(0);
});

test("cooperative filesystem guard stop writes an identity-bound request then verifies cleanup", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-stop-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  const receipt = launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 61, unref: () => {}, kill: () => {} }), probeProcess: () => "owned" });
  let state: "owned" | "missing" = "owned";

  const report = stopPersistentFsGuard({
    directory,
    probeProcess: () => state,
    sleep: () => {
      expect(JSON.parse(readFileSync(fsGuardStopRequestPath(directory), "utf8"))).toEqual({ schemaVersion: 1, instanceId: receipt.instanceId });
      state = "missing";
    },
  });

  expect(report).toEqual({ stopped: true, staleReceipt: false });
  expect(existsSync(fsGuardReceiptPath(directory))).toBeFalse();
  expect(existsSync(fsGuardStopRequestPath(directory))).toBeFalse();
});

test("filesystem guard stop never signals a foreign process or removes recovery evidence", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-stop-foreign-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 71, unref: () => {}, kill: () => {} }), probeProcess: () => "owned" });

  expect(() => stopPersistentFsGuard({ directory, probeProcess: () => "foreign" })).toThrow("belongs to another process");
  expect(existsSync(fsGuardReceiptPath(directory))).toBeTrue();
  expect(existsSync(fsGuardStopRequestPath(directory))).toBeFalse();
});

test("filesystem guard stop preserves recovery evidence when process identity becomes unknown", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-stop-unknown-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 72, unref: () => {}, kill: () => {} }), probeProcess: () => "owned" });
  let probes = 0;

  expect(() => stopPersistentFsGuard({
    directory,
    timeoutMs: 0,
    probeProcess: () => ++probes === 1 ? "owned" : "unknown",
  })).toThrow("receipt preserved");
  expect(existsSync(fsGuardReceiptPath(directory))).toBeTrue();
  expect(existsSync(fsGuardStopRequestPath(directory))).toBeTrue();
});

test("filesystem guard child refuses to run without its exact launch receipt", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-orphan-"));
  temporaryDirectories.push(directory);

  expect(() => waitForFsGuardLaunchReceipt({
    directory,
    instanceId: "11111111-1111-4111-8111-111111111111",
    pid: 81,
    timeoutMs: 0,
  })).toThrow("exiting to avoid an orphan");
});

test("filesystem guard child accepts only matching stop requests", async () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-child-"));
  temporaryDirectories.push(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  const receipt = launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 91, unref: () => {}, kill: () => {} }), probeProcess: () => "owned" });
  let stopped = false;
  const watcher = watchFsGuardStopRequests({ directory, instanceId: receipt.instanceId, pid: receipt.pid }, () => { stopped = true; });
  writeFileSync(fsGuardStopRequestPath(directory), JSON.stringify({ schemaVersion: 1, instanceId: "22222222-2222-4222-8222-222222222222" }));
  await Bun.sleep(40);
  expect(stopped).toBeFalse();
  writeFileSync(fsGuardStopRequestPath(directory), JSON.stringify({ schemaVersion: 1, instanceId: receipt.instanceId }));
  for (let attempt = 0; attempt < 20 && !stopped; attempt += 1) await Bun.sleep(10);
  watcher.close();
  expect(stopped).toBeTrue();
});
