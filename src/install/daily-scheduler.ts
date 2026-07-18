import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { applyAtomicFilePlans, type AtomicFilePlan } from "./atomic-files";

export type DailySchedulerPlatform = "win32" | "darwin" | "linux";

export interface SchedulerCommandResult {
  exitCode: number;
  stdout?: string | Uint8Array;
  stderr?: string | Uint8Array;
}

export type SchedulerCommandRunner = (command: readonly string[]) => SchedulerCommandResult;

export interface DailySchedulerOptions {
  home: string;
  userHome: string;
  executable: string;
  trustedExecutableRoot: string;
  platform?: DailySchedulerPlatform;
  uid?: number;
  now?: Date;
  runner?: SchedulerCommandRunner;
  nativeExecutables?: Partial<Record<"launchctl" | "powershell" | "schtasks" | "systemctl", string>>;
}

export interface DailySchedulerReceipt {
  schemaVersion: 1;
  owner: "vibebloat";
  kind: "daily-scheduler";
  platform: DailySchedulerPlatform;
  target: string;
  command: string[];
  commandSha256: string;
  executableSha256: string;
  configPaths: string[];
  configSha256: string;
  installedAt: string;
}

export type DailySchedulerHealth = "absent" | "healthy" | "unhealthy";

interface PreparedScheduler {
  platform: DailySchedulerPlatform;
  home: string;
  userHome: string;
  command: string[];
  target: string;
  receiptPath: string;
  configs: AtomicFilePlan[];
  commandSha256: string;
  executableSha256: string;
  configSha256: string;
  installedAt: string;
  runner: SchedulerCommandRunner;
  tools: Record<string, string>;
  uid?: number;
}

interface FileSnapshot {
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

const owner = "vibebloat" as const;
const label = "dev.vibebloat.daily";
const windowsTarget = "\\VibeBloat\\Daily";
const futureClockSkewMilliseconds = 5 * 60 * 1000;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeOutput(value: string | Uint8Array | undefined): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  const bytes = Buffer.from(value);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.alloc(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  return bytes.toString("utf8");
}

function defaultRunner(command: readonly string[]): SchedulerCommandResult {
  const result = Bun.spawnSync([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

function commandFailure(action: string, result: SchedulerCommandResult): Error {
  const detail = decodeOutput(result.stderr).trim() || decodeOutput(result.stdout).trim() || `exit ${result.exitCode}`;
  return new Error(`${action} failed: ${detail}`);
}

function assertAbsoluteDirectory(path: string, name: string): string {
  if (!isAbsolute(path) || !existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${name} must be an existing absolute directory.`);
  const real = realpathSync(path);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${name} cannot be a symbolic link or junction.`);
  return real;
}

function assertConfinedNoLinks(anchor: string, target: string, name: string): void {
  const relativePath = relative(anchor, target);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${name} must stay inside its owned directory.`);
  let current = anchor;
  if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`${name} cannot traverse a symbolic link or junction.`);
  for (const segment of relativePath.split(/[\\/]/)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`${name} cannot traverse a symbolic link or junction.`);
  }
}

function assertTrustedExecutable(path: string, trustedRoot: string, platform: DailySchedulerPlatform): string {
  if (!isAbsolute(path)) throw new Error("Daily scheduler executable must be absolute.");
  const absolute = resolve(path);
  assertConfinedNoLinks(trustedRoot, absolute, "Daily scheduler executable");
  if (!existsSync(absolute)) throw new Error("Daily scheduler executable does not exist.");
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Daily scheduler executable must be a regular file.");
  if (platform !== "win32" && process.platform !== "win32") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && info.uid !== currentUid && info.uid !== 0) throw new Error("Daily scheduler executable owner is not trusted.");
    if ((info.mode & 0o022) !== 0) throw new Error("Daily scheduler executable cannot be group- or world-writable.");
    if ((info.mode & 0o111) === 0) throw new Error("Daily scheduler executable is not executable.");
  }
  return realpathSync(absolute);
}

function resolveNativeTool(name: keyof NonNullable<DailySchedulerOptions["nativeExecutables"]>, options: DailySchedulerOptions, platform: DailySchedulerPlatform): string {
  const configured = options.nativeExecutables?.[name];
  if (configured && !options.runner) throw new Error("Scheduler tool overrides require an injected command runner.");
  let found = configured;
  if (!found && platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw new Error("Windows system root is unavailable.");
    const trustedSystemRoot = assertAbsoluteDirectory(systemRoot, "Windows system root");
    found = name === "powershell"
      ? join(trustedSystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : join(trustedSystemRoot, "System32", "schtasks.exe");
    assertConfinedNoLinks(trustedSystemRoot, found, `Required scheduler tool ${name}`);
  }
  if (!found && platform === "darwin") found = "/bin/launchctl";
  if (!found && platform === "linux") found = ["/usr/bin/systemctl", "/bin/systemctl"].find(existsSync);
  if (!found || !isAbsolute(found) || !existsSync(found)) throw new Error(`Required scheduler tool is unavailable: ${name}.`);
  const resolved = realpathSync(found);
  const info = lstatSync(resolved);
  if (!info.isFile()) throw new Error(`Required scheduler tool is untrusted: ${name}.`);
  if (!configured && platform === "win32" && resolve(found).toLowerCase() !== resolve(resolved).toLowerCase()) throw new Error(`Required scheduler tool is untrusted: ${name}.`);
  if (platform !== "win32" && process.platform !== "win32") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const trustedOwner = configured ? info.uid === currentUid || info.uid === 0 : info.uid === 0;
    if (currentUid !== undefined && !trustedOwner) throw new Error(`Required scheduler tool owner is untrusted: ${name}.`);
    if ((info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) throw new Error(`Required scheduler tool permissions are untrusted: ${name}.`);
  }
  return resolved;
}

export function quoteWindowsCommandLineArgument(argument: string): string {
  if (argument.includes("\0") || argument.includes("\r") || argument.includes("\n")) throw new Error("Windows scheduler arguments cannot contain control characters.");
  if (argument.length > 0 && !/[\s"]/.test(argument)) return argument;
  let quoted = '"';
  let backslashes = 0;
  for (const character of argument) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += "\\".repeat(backslashes) + character;
    backslashes = 0;
  }
  return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

function windowsCommandLine(command: readonly string[]): string {
  return command.map(quoteWindowsCommandLineArgument).join(" ");
}

function xmlEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function plist(command: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>${label}</string>\n  <key>ProgramArguments</key>\n  <array>\n${command.map((part) => `    <string>${xmlEscape(part)}</string>`).join("\n")}\n  </array>\n  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key><integer>3</integer>\n    <key>Minute</key><integer>0</integer>\n  </dict>\n</dict>\n</plist>\n`;
}

function systemdQuote(argument: string): string {
  if (argument.includes("\0") || argument.includes("\r") || argument.includes("\n")) throw new Error("Systemd scheduler arguments cannot contain control characters.");
  return `"${argument.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "$$").replaceAll("%", "%%")}"`;
}

function serviceUnit(command: readonly string[]): string {
  return `[Unit]\nDescription=VibeBloat daily strengthening\n\n[Service]\nType=oneshot\nExecStart=${command.map(systemdQuote).join(" ")}\n`;
}

function timerUnit(): string {
  return `[Unit]\nDescription=Run VibeBloat daily strengthening\n\n[Timer]\nOnCalendar=*-*-* 03:00:00\nPersistent=true\nUnit=vibebloat-daily.service\n\n[Install]\nWantedBy=timers.target\n`;
}

function configDigest(configs: readonly AtomicFilePlan[]): string {
  return sha256(JSON.stringify(configs.map((config) => ({ path: resolve(config.path), sha256: sha256(config.content) }))));
}

function prepare(options: DailySchedulerOptions): PreparedScheduler {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") throw new Error("Daily scheduler platform is unsupported.");
  const home = assertAbsoluteDirectory(options.home, "VibeBloat home");
  const userHome = assertAbsoluteDirectory(options.userHome, "User home");
  const trustedRoot = assertAbsoluteDirectory(options.trustedExecutableRoot, "Trusted executable root");
  const executable = assertTrustedExecutable(options.executable, trustedRoot, platform);
  const command = [executable, "daily"];
  const receiptPath = join(home, "receipts", "daily-scheduler.json");
  assertConfinedNoLinks(home, receiptPath, "Daily scheduler receipt");
  const installedAt = options.now ?? new Date();
  if (!Number.isFinite(installedAt.getTime())) throw new Error("Daily scheduler clock is invalid.");

  let target: string;
  let configs: AtomicFilePlan[];
  const tools: Record<string, string> = {};
  let uid = options.uid;
  if (platform === "win32") {
    target = windowsTarget;
    const descriptorPath = join(home, "scheduler", "windows-daily.json");
    assertConfinedNoLinks(home, descriptorPath, "Windows scheduler descriptor");
    configs = [{ path: descriptorPath, content: `${JSON.stringify({ schemaVersion: 1, target, command, trigger: "daily", start: "03:00" }, null, 2)}\n`, mode: 0o600 }];
    tools.powershell = resolveNativeTool("powershell", options, platform);
    tools.schtasks = resolveNativeTool("schtasks", options, platform);
  } else if (platform === "darwin") {
    if (!Number.isSafeInteger(uid) || uid! < 0) uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!Number.isSafeInteger(uid) || uid! < 0) throw new Error("Launchd scheduler requires a valid user id.");
    target = `gui/${uid}/${label}`;
    const configPath = join(userHome, "Library", "LaunchAgents", `${label}.plist`);
    assertConfinedNoLinks(userHome, configPath, "Launchd scheduler configuration");
    configs = [{ path: configPath, content: plist(command), mode: 0o600 }];
    tools.launchctl = resolveNativeTool("launchctl", options, platform);
  } else {
    target = "vibebloat-daily.timer";
    const unitRoot = join(userHome, ".config", "systemd", "user");
    assertConfinedNoLinks(userHome, join(unitRoot, "vibebloat-daily.service"), "Systemd scheduler configuration");
    assertConfinedNoLinks(userHome, join(unitRoot, target), "Systemd scheduler configuration");
    configs = [
      { path: join(unitRoot, "vibebloat-daily.service"), content: serviceUnit(command), mode: 0o600 },
      { path: join(unitRoot, target), content: timerUnit(), mode: 0o600 },
    ];
    tools.systemctl = resolveNativeTool("systemctl", options, platform);
  }

  return {
    platform,
    home,
    userHome,
    command,
    target,
    receiptPath,
    configs,
    commandSha256: sha256(JSON.stringify(command)),
    executableSha256: sha256(readFileSync(executable)),
    configSha256: configDigest(configs),
    installedAt: installedAt.toISOString(),
    runner: options.runner ?? defaultRunner,
    tools,
    uid,
  };
}

function inspectWindows(prepared: PreparedScheduler): "absent" | "present" | "mismatch" {
  const script = `$ErrorActionPreference='Stop';try{$t=Get-ScheduledTask -TaskPath '\\VibeBloat\\' -TaskName 'Daily' -ErrorAction Stop}catch{if($_.FullyQualifiedErrorId -eq 'CmdletizationQuery_NotFound,Get-ScheduledTask' -and $_.CategoryInfo.Reason -eq 'CimJobException'){exit 3};[Console]::Error.Write($_.Exception.Message);exit 2};$a=@($t.Actions);$g=@($t.Triggers);if($a.Count -ne 1 -or $g.Count -ne 1){exit 4};$start=[datetime]$g[0].StartBoundary;[Console]::Out.Write((@{execute=[string]$a[0].Execute;arguments=[string]$a[0].Arguments;enabled=[bool]$t.Settings.Enabled;daysInterval=[int]$g[0].DaysInterval;triggerEnabled=[bool]$g[0].Enabled;hour=$start.Hour;minute=$start.Minute}|ConvertTo-Json -Compress))`;
  const result = prepared.runner([prepared.tools.powershell, "-NoProfile", "-NonInteractive", "-Command", script]);
  if (result.exitCode === 3) return "absent";
  if (result.exitCode !== 0) throw commandFailure("Windows scheduler inspection", result);
  let action: { execute?: unknown; arguments?: unknown; enabled?: unknown; daysInterval?: unknown; triggerEnabled?: unknown; hour?: unknown; minute?: unknown };
  try {
    action = JSON.parse(decodeOutput(result.stdout));
  } catch {
    throw new Error("Windows scheduler inspection returned malformed action data.");
  }
  const expectedArguments = prepared.command.slice(1).map(quoteWindowsCommandLineArgument).join(" ");
  return typeof action.execute === "string"
    && resolve(action.execute).toLowerCase() === resolve(prepared.command[0]).toLowerCase()
    && action.arguments === expectedArguments
    && action.enabled === true
    && action.daysInterval === 1
    && action.triggerEnabled === true
    && action.hour === 3
    && action.minute === 0
    ? "present"
    : "mismatch";
}

function parseLaunchctlArguments(output: string): string[] {
  const block = output.match(/arguments\s*=\s*\{([\s\S]*?)\n\s*\}/)?.[1];
  if (!block) return [];
  return block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.replace(/^\d+\s*=\s*/, ""));
}

function inspectDarwin(prepared: PreparedScheduler): "absent" | "present" | "mismatch" {
  const result = prepared.runner([prepared.tools.launchctl, "print", prepared.target]);
  if (result.exitCode === 113) return "absent";
  if (result.exitCode !== 0) throw commandFailure("Launchd scheduler inspection", result);
  const output = decodeOutput(result.stdout);
  const program = output.match(/^\s*program\s*=\s*(.+)$/m)?.[1]?.trim();
  const arguments_ = parseLaunchctlArguments(output);
  const triggerBlock = output.match(/event triggers\s*=\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";
  const hours = [...triggerBlock.matchAll(/\bHour\s*(?:=>|=)\s*(\d+)/g)].map((match) => Number(match[1]));
  const minutes = [...triggerBlock.matchAll(/\bMinute\s*(?:=>|=)\s*(\d+)/g)].map((match) => Number(match[1]));
  return program === prepared.command[0]
    && JSON.stringify(arguments_) === JSON.stringify(prepared.command)
    && hours.length > 0 && hours.every((hour) => hour === 3)
    && minutes.length > 0 && minutes.every((minute) => minute === 0)
    ? "present"
    : "mismatch";
}

function parseSystemdShow(output: string): Record<string, string> {
  return Object.fromEntries(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("=");
    return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function inspectLinux(prepared: PreparedScheduler): "absent" | "present" | "mismatch" {
  const timer = prepared.runner([prepared.tools.systemctl, "--user", "show", prepared.target, "--property=LoadState", "--property=FragmentPath", "--property=UnitFileState", "--property=ActiveState"]);
  if (timer.exitCode !== 0) throw commandFailure("Systemd timer inspection", timer);
  const timerState = parseSystemdShow(decodeOutput(timer.stdout));
  if (timerState.LoadState === "not-found") return "absent";
  const service = prepared.runner([prepared.tools.systemctl, "--user", "show", "vibebloat-daily.service", "--property=LoadState", "--property=FragmentPath"]);
  if (service.exitCode !== 0) throw commandFailure("Systemd service inspection", service);
  const serviceState = parseSystemdShow(decodeOutput(service.stdout));
  return timerState.LoadState === "loaded"
    && resolve(timerState.FragmentPath ?? "") === resolve(prepared.configs[1].path)
    && timerState.UnitFileState === "enabled"
    && timerState.ActiveState === "active"
    && serviceState.LoadState === "loaded"
    && resolve(serviceState.FragmentPath ?? "") === resolve(prepared.configs[0].path)
    ? "present"
    : "mismatch";
}

function inspectNative(prepared: PreparedScheduler): "absent" | "present" | "mismatch" {
  if (prepared.platform === "win32") return inspectWindows(prepared);
  if (prepared.platform === "darwin") return inspectDarwin(prepared);
  return inspectLinux(prepared);
}

function installNative(prepared: PreparedScheduler): void {
  let result: SchedulerCommandResult;
  if (prepared.platform === "win32") {
    result = prepared.runner([prepared.tools.schtasks, "/Create", "/TN", prepared.target, "/SC", "DAILY", "/ST", "03:00", "/TR", windowsCommandLine(prepared.command)]);
  } else if (prepared.platform === "darwin") {
    result = prepared.runner([prepared.tools.launchctl, "bootstrap", `gui/${prepared.uid}`, prepared.configs[0].path]);
  } else {
    result = prepared.runner([prepared.tools.systemctl, "--user", "daemon-reload"]);
    if (result.exitCode === 0) result = prepared.runner([prepared.tools.systemctl, "--user", "enable", "--now", prepared.target]);
  }
  if (result.exitCode !== 0) throw commandFailure("Daily scheduler installation", result);
}

function removeNative(prepared: PreparedScheduler): void {
  let result: SchedulerCommandResult;
  if (prepared.platform === "win32") result = prepared.runner([prepared.tools.schtasks, "/Delete", "/TN", prepared.target, "/F"]);
  else if (prepared.platform === "darwin") result = prepared.runner([prepared.tools.launchctl, "bootout", prepared.target]);
  else result = prepared.runner([prepared.tools.systemctl, "--user", "disable", "--now", prepared.target]);
  if (result.exitCode !== 0) throw commandFailure("Daily scheduler rollback", result);
  if (prepared.platform === "linux") {
    const reload = prepared.runner([prepared.tools.systemctl, "--user", "daemon-reload"]);
    if (reload.exitCode !== 0) throw commandFailure("Systemd rollback reload", reload);
  }
}

function snapshot(path: string): FileSnapshot {
  if (!existsSync(path)) return { existed: false };
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Daily scheduler state path is not a regular file.");
  return { existed: true, content: readFileSync(path), mode: info.mode };
}

function restore(path: string, value: FileSnapshot): void {
  if (!value.existed) {
    rmSync(path, { force: true });
    return;
  }
  applyAtomicFilePlans([{ path, content: value.content!, mode: value.mode }]);
}

function parseReceipt(source: string): DailySchedulerReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Daily scheduler receipt is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Daily scheduler receipt is malformed.");
  const receipt = parsed as Record<string, unknown>;
  if (Object.keys(receipt).sort().join(",") !== "command,commandSha256,configPaths,configSha256,executableSha256,installedAt,kind,owner,platform,schemaVersion,target"
    || receipt.schemaVersion !== 1 || receipt.owner !== owner || receipt.kind !== "daily-scheduler"
    || (receipt.platform !== "win32" && receipt.platform !== "darwin" && receipt.platform !== "linux")
    || typeof receipt.target !== "string" || !receipt.target
    || !Array.isArray(receipt.command) || receipt.command.length !== 2 || receipt.command.some((part) => typeof part !== "string" || !part)
    || typeof receipt.commandSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.commandSha256)
    || typeof receipt.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.executableSha256)
    || !Array.isArray(receipt.configPaths) || receipt.configPaths.length < 1 || receipt.configPaths.some((path) => typeof path !== "string" || !isAbsolute(path))
    || typeof receipt.configSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.configSha256)
    || typeof receipt.installedAt !== "string" || !Number.isFinite(Date.parse(receipt.installedAt))) {
    throw new Error("Daily scheduler receipt is not VibeBloat-owned.");
  }
  return receipt as unknown as DailySchedulerReceipt;
}

function verifyOwnedFile(path: string, platform: DailySchedulerPlatform): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Daily scheduler state is not a regular file.");
  if (platform !== "win32" && process.platform !== "win32") {
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && info.uid !== currentUid) throw new Error("Daily scheduler state owner is invalid.");
    if ((info.mode & 0o077) !== 0) throw new Error("Daily scheduler state permissions are too broad.");
  }
}

function readAndVerify(prepared: PreparedScheduler, now: Date): DailySchedulerReceipt {
  if (!existsSync(prepared.receiptPath)) throw new Error("Daily scheduler receipt is missing.");
  assertConfinedNoLinks(prepared.home, prepared.receiptPath, "Daily scheduler receipt");
  verifyOwnedFile(prepared.receiptPath, prepared.platform);
  const receipt = parseReceipt(readFileSync(prepared.receiptPath, "utf8"));
  const installedAt = Date.parse(receipt.installedAt);
  if (!Number.isFinite(now.getTime()) || installedAt > now.getTime() + futureClockSkewMilliseconds) throw new Error("Daily scheduler receipt timestamp is invalid.");
  const receiptMtime = statSync(prepared.receiptPath).mtimeMs;
  if (installedAt > receiptMtime + futureClockSkewMilliseconds) throw new Error("Daily scheduler receipt timestamp does not match its file.");
  if (receipt.platform !== prepared.platform || receipt.target !== prepared.target
    || JSON.stringify(receipt.command) !== JSON.stringify(prepared.command)
    || receipt.commandSha256 !== prepared.commandSha256
    || receipt.executableSha256 !== prepared.executableSha256
    || JSON.stringify(receipt.configPaths) !== JSON.stringify(prepared.configs.map(({ path }) => resolve(path)))) {
    throw new Error("Daily scheduler receipt does not match this installation.");
  }
  for (const config of prepared.configs) {
    const anchor = prepared.platform === "win32" ? prepared.home : prepared.userHome;
    assertConfinedNoLinks(anchor, resolve(config.path), "Daily scheduler configuration");
    if (!existsSync(config.path)) throw new Error("Daily scheduler configuration is missing.");
    verifyOwnedFile(config.path, prepared.platform);
  }
  const currentConfigs = prepared.configs.map((config) => ({ ...config, content: readFileSync(config.path) }));
  if (receipt.configSha256 !== configDigest(currentConfigs) || receipt.configSha256 !== prepared.configSha256) throw new Error("Daily scheduler configuration digest does not match.");
  if (sha256(JSON.stringify(receipt.command)) !== receipt.commandSha256 || sha256(readFileSync(prepared.command[0])) !== receipt.executableSha256) {
    throw new Error("Daily scheduler command digest does not match.");
  }
  if (inspectNative(prepared) !== "present") throw new Error("Native daily scheduler does not match its receipt.");
  return receipt;
}

export function dailySchedulerReceiptPath(home: string): string {
  return join(resolve(home), "receipts", "daily-scheduler.json");
}

export function inspectDailyScheduler(options: DailySchedulerOptions): DailySchedulerHealth {
  let prepared: PreparedScheduler;
  try {
    prepared = prepare(options);
  } catch {
    return "unhealthy";
  }
  const hasReceipt = existsSync(prepared.receiptPath);
  const hasConfig = prepared.configs.some(({ path }) => existsSync(path));
  try {
    if (!hasReceipt) {
      const native = inspectNative(prepared);
      return !hasConfig && native === "absent" ? "absent" : "unhealthy";
    }
    readAndVerify(prepared, options.now ?? new Date());
    return "healthy";
  } catch {
    return "unhealthy";
  }
}

export function installDailyScheduler(options: DailySchedulerOptions): DailySchedulerReceipt {
  const prepared = prepare(options);
  if (existsSync(prepared.receiptPath)) return readAndVerify(prepared, options.now ?? new Date());
  if (prepared.configs.some(({ path }) => existsSync(path))) throw new Error("Daily scheduler configuration exists without a verified receipt.");
  if (inspectNative(prepared) !== "absent") throw new Error("Native daily scheduler target is already occupied.");

  const snapshots = new Map(prepared.configs.map(({ path }) => [path, snapshot(path)]));
  const receiptSnapshot = snapshot(prepared.receiptPath);
  let nativeMutationAttempted = false;
  try {
    applyAtomicFilePlans(prepared.configs);
    nativeMutationAttempted = true;
    installNative(prepared);
    if (inspectNative(prepared) !== "present") throw new Error("Native daily scheduler verification failed after installation.");
    const receipt: DailySchedulerReceipt = {
      schemaVersion: 1,
      owner,
      kind: "daily-scheduler",
      platform: prepared.platform,
      target: prepared.target,
      command: prepared.command,
      commandSha256: prepared.commandSha256,
      executableSha256: prepared.executableSha256,
      configPaths: prepared.configs.map(({ path }) => resolve(path)),
      configSha256: prepared.configSha256,
      installedAt: prepared.installedAt,
    };
    applyAtomicFilePlans([{ path: prepared.receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600 }]);
    return readAndVerify(prepared, options.now ?? new Date());
  } catch (error) {
    const rollbackErrors: string[] = [];
    if (nativeMutationAttempted) {
      try {
        const native = inspectNative(prepared);
        if (native === "present") removeNative(prepared);
        else if (native === "mismatch") rollbackErrors.push("Native scheduler target changed during installation; refusing to delete unverified state.");
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    for (const config of [...prepared.configs].reverse()) {
      try { restore(config.path, snapshots.get(config.path)!); } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
    }
    try { restore(prepared.receiptPath, receiptSnapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError)); }
    if (prepared.platform === "linux") {
      const reload = prepared.runner([prepared.tools.systemctl, "--user", "daemon-reload"]);
      if (reload.exitCode !== 0) rollbackErrors.push(commandFailure("Systemd rollback reload", reload).message);
    }
    if (rollbackErrors.length > 0) throw new Error(`Daily scheduler install failed and rollback was incomplete: ${rollbackErrors.join("; ")}`, { cause: error });
    throw error;
  }
}
