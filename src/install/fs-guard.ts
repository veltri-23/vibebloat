import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runFileGuard, type HookResponse } from "../hooks";
import { Runtime } from "../runtime";
import type { Guard } from "../types";
import { applyAtomicFilePlans } from "./atomic-files";

export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface FsGuardLaunchReceipt {
  schemaVersion: 1;
  owner: "vibebloat";
  kind: "fs-guard";
  pid: number;
  directory: string;
  command: string[];
  instanceId: string;
  launchedAt: string;
}

export interface DetachedFsGuardProcess {
  pid: number;
  unref(): void;
  kill(): void;
}

export interface FsGuardLaunchOptions {
  directory: string;
  receiptPath?: string;
  command: readonly string[];
  spawn?: (command: readonly string[], cwd: string) => DetachedFsGuardProcess;
  probeProcess?: (pid: number, instanceId: string) => ProcessIdentityState;
  sleep?: (milliseconds: number) => void;
  instanceId?: string;
  now?: Date;
}

export interface FsGuardStopOptions {
  directory: string;
  receiptPath?: string;
  probeProcess?: (pid: number, instanceId: string) => ProcessIdentityState;
  sleep?: (milliseconds: number) => void;
  timeoutMs?: number;
}

export type ProcessIdentityState = "owned" | "missing" | "foreign" | "unknown";

export interface FsGuardStopReport {
  stopped: boolean;
  staleReceipt: boolean;
}

export interface FsGuardChildLifecycleOptions {
  directory: string;
  instanceId: string;
  pid?: number;
  receiptPath?: string;
  sleep?: (milliseconds: number) => void;
  timeoutMs?: number;
}

export interface FsGuardStopWatcher {
  close(): void;
}

export type PersistentFsGuardHealth = "absent" | "healthy" | "unhealthy";

export interface PersistentFsGuardHealthOptions {
  directory: string;
  probeProcess?: (pid: number, instanceId: string) => ProcessIdentityState;
}

interface GuardedFileSnapshot {
  content?: Buffer;
  existed: boolean;
  mode?: number;
}

const instanceArgument = "--vibebloat-fs-guard-instance";
const receiptArgument = "--vibebloat-fs-guard-receipt";
const instanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultSpawn(command: readonly string[], cwd: string): DetachedFsGuardProcess {
  return Bun.spawn([...command], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  }) as DetachedFsGuardProcess;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(milliseconds: number): void {
  Bun.sleepSync(milliseconds);
}

function commandLineForProcess(pid: number): string | undefined {
  if (!processIsAlive(pid)) return undefined;
  if (process.platform === "linux") {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join("\n");
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    const shell = Bun.which("powershell.exe") ?? Bun.which("pwsh.exe");
    if (!shell) return undefined;
    const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -eq $p) { exit 3 }; [Console]::Out.Write($p.CommandLine)`;
    const result = Bun.spawnSync([shell, "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "pipe", stderr: "ignore" });
    return result.exitCode === 0 ? result.stdout.toString() : undefined;
  }
  const ps = Bun.which("ps");
  if (!ps) return undefined;
  const result = Bun.spawnSync([ps, "-ww", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}

function defaultProbeProcess(pid: number, instanceId: string): ProcessIdentityState {
  if (!processIsAlive(pid)) return "missing";
  const commandLine = commandLineForProcess(pid);
  if (!commandLine) return "unknown";
  return commandLine.includes(`${instanceArgument}=${instanceId}`) ? "owned" : "foreign";
}

function parseReceipt(source: string): FsGuardLaunchReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Filesystem guard receipt is malformed; refusing to overwrite it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Filesystem guard receipt is malformed; refusing to overwrite it.");
  const receipt = parsed as Record<string, unknown>;
  const keys = Object.keys(receipt).sort().join(",");
  if (keys !== "command,directory,instanceId,kind,launchedAt,owner,pid,schemaVersion"
    || receipt.schemaVersion !== 1
    || receipt.owner !== "vibebloat"
    || receipt.kind !== "fs-guard"
    || !Number.isSafeInteger(receipt.pid) || (receipt.pid as number) <= 0
    || typeof receipt.directory !== "string" || !isAbsolute(receipt.directory)
    || !Array.isArray(receipt.command) || receipt.command.length < 3 || receipt.command.some((part) => typeof part !== "string" || !part)
    || typeof receipt.instanceId !== "string" || !instanceIdPattern.test(receipt.instanceId)
    || typeof receipt.launchedAt !== "string" || Number.isNaN(Date.parse(receipt.launchedAt))) {
    throw new Error("Filesystem guard receipt is not VibeBloat-owned; refusing to overwrite it.");
  }
  return receipt as unknown as FsGuardLaunchReceipt;
}

export function fsGuardReceiptPath(repository: string): string {
  return join(resolve(repository), ".vibebloat", "receipts", "fs-guard.json");
}

export function fsGuardStopRequestPath(repository: string): string {
  return join(resolve(repository), ".vibebloat", "receipts", "fs-guard.stop.json");
}

export function inspectPersistentFsGuard(options: PersistentFsGuardHealthOptions): PersistentFsGuardHealth {
  try {
    const directory = realpathSync(resolve(options.directory));
    if (!statSync(directory).isDirectory()) return "unhealthy";
    const receiptPath = fsGuardReceiptPath(directory);
    if (!existsSync(receiptPath)) return "absent";
    if (lstatSync(receiptPath).isSymbolicLink()) return "unhealthy";
    assertNoSymlinkedReceiptParent(join(directory, ".vibebloat"), receiptPath);
    const receipt = parseReceipt(readFileSync(receiptPath, "utf8"));
    if (receipt.directory !== directory) return "unhealthy";
    return (options.probeProcess ?? defaultProbeProcess)(receipt.pid, receipt.instanceId) === "owned"
      ? "healthy"
      : "unhealthy";
  } catch {
    return "unhealthy";
  }
}

function assertNoSymlinkedReceiptParent(ownedRoot: string, receiptPath: string): void {
  let current = dirname(receiptPath);
  while (current !== ownedRoot) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("Filesystem guard receipt parent cannot be a symbolic link.");
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("Filesystem guard receipt escaped its owned directory.");
    current = parent;
  }
  if (existsSync(ownedRoot) && lstatSync(ownedRoot).isSymbolicLink()) {
    throw new Error("Filesystem guard receipt parent cannot be a symbolic link.");
  }
}

function preflightLaunch(options: FsGuardLaunchOptions): { directory: string; receiptPath: string; command: string[]; launchedAt: string } {
  if (!isAbsolute(options.directory) || !existsSync(options.directory) || !statSync(options.directory).isDirectory()) {
    throw new Error("Filesystem guard directory must be an existing absolute directory.");
  }
  const directory = realpathSync(options.directory);
  const receiptPath = resolve(options.receiptPath ?? fsGuardReceiptPath(directory));
  const ownedRoot = join(directory, ".vibebloat");
  const receiptRelative = relative(ownedRoot, receiptPath);
  if (!receiptRelative || receiptRelative.startsWith("..") || isAbsolute(receiptRelative)) {
    throw new Error("Filesystem guard receipt must stay inside the repository .vibebloat directory.");
  }
  assertNoSymlinkedReceiptParent(ownedRoot, receiptPath);
  const command = [...options.command];
  const watchIndex = command.indexOf("watch");
  if (command.length < 3 || !isAbsolute(command[0]) || !existsSync(command[0]) || !statSync(command[0]).isFile()
    || watchIndex < 1 || resolve(command[watchIndex + 1] ?? "") !== directory) {
    throw new Error("Filesystem guard launch command must use an absolute executable and watch this repository.");
  }
  const launchedAt = options.now ?? new Date();
  if (!Number.isFinite(launchedAt.getTime())) throw new Error("Filesystem guard launch clock is invalid.");
  return { directory, receiptPath, command, launchedAt: launchedAt.toISOString() };
}

function lifecycleCommand(command: readonly string[], receiptPath: string, instanceId: string): string[] {
  if (command.some((part) => part === instanceArgument || part.startsWith(`${instanceArgument}=`)
    || part === receiptArgument || part.startsWith(`${receiptArgument}=`))) {
    throw new Error("Filesystem guard launch command cannot set reserved lifecycle arguments.");
  }
  return [...command, `${instanceArgument}=${instanceId}`, `${receiptArgument}=${receiptPath}`];
}

function baseCommand(command: readonly string[]): string[] {
  return command.filter((part) => !part.startsWith(`${instanceArgument}=`) && !part.startsWith(`${receiptArgument}=`));
}

function stopRequestPath(receiptPath: string): string {
  return join(dirname(receiptPath), "fs-guard.stop.json");
}

function lifecycleLockPath(receiptPath: string): string {
  return join(dirname(receiptPath), "fs-guard.lifecycle.lock");
}

function withLifecycleLock<T>(receiptPath: string, action: () => T): T {
  const parent = dirname(receiptPath);
  mkdirSync(parent, { recursive: true });
  const ownedRoot = dirname(parent);
  assertNoSymlinkedReceiptParent(ownedRoot, receiptPath);
  const lockPath = lifecycleLockPath(receiptPath);
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch {
    throw new Error("Filesystem guard lifecycle is already changing; retry after it finishes.");
  }
  try {
    return action();
  } finally {
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

function removeOwnedFileAtomically(path: string): void {
  if (!existsSync(path)) return;
  if (lstatSync(path).isSymbolicLink()) throw new Error("Filesystem guard lifecycle file cannot be a symbolic link.");
  const removedPath = `${path}.removed-${process.pid}-${randomUUID()}`;
  renameSync(path, removedPath);
  rmSync(removedPath);
  if (existsSync(path) || existsSync(removedPath)) throw new Error("Filesystem guard lifecycle cleanup could not be verified.");
}

function waitForProcessState(
  pid: number,
  instanceId: string,
  wanted: ProcessIdentityState,
  probeProcess: (pid: number, instanceId: string) => ProcessIdentityState,
  sleep: (milliseconds: number) => void,
  timeoutMs: number,
): ProcessIdentityState {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 25));
  let state = probeProcess(pid, instanceId);
  for (let attempt = 1; state !== wanted && attempt < attempts; attempt += 1) {
    sleep(25);
    state = probeProcess(pid, instanceId);
  }
  return state;
}

function waitForOwnedProcessExit(pid: number, sleep: (milliseconds: number) => void, timeoutMs: number): ProcessIdentityState {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 25));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!processIsAlive(pid)) return "missing";
    if (attempt + 1 < attempts) sleep(25);
  }
  return processIsAlive(pid) ? "owned" : "missing";
}

export function launchPersistentFsGuard(options: FsGuardLaunchOptions): FsGuardLaunchReceipt {
  const prepared = preflightLaunch(options);
  const probeProcess = options.probeProcess ?? defaultProbeProcess;
  const sleep = options.sleep ?? defaultSleep;
  return withLifecycleLock(prepared.receiptPath, () => {
    if (existsSync(prepared.receiptPath)) {
      if (lstatSync(prepared.receiptPath).isSymbolicLink()) throw new Error("Filesystem guard receipt cannot be a symbolic link.");
      const existing = parseReceipt(readFileSync(prepared.receiptPath, "utf8"));
      const state = probeProcess(existing.pid, existing.instanceId);
      if (state === "owned") {
        if (existing.directory === prepared.directory && JSON.stringify(baseCommand(existing.command)) === JSON.stringify(prepared.command)) return existing;
        throw new Error("A different VibeBloat filesystem guard is still running; refusing to orphan it.");
      }
      if (state === "foreign") throw new Error("Filesystem guard receipt PID belongs to another process; refusing to replace it.");
      if (state === "unknown") throw new Error("Filesystem guard process identity could not be verified; refusing to replace it.");
      removeOwnedFileAtomically(prepared.receiptPath);
    }
    removeOwnedFileAtomically(stopRequestPath(prepared.receiptPath));

    const instanceId = options.instanceId ?? randomUUID();
    if (!instanceIdPattern.test(instanceId)) throw new Error("Filesystem guard instance identity is invalid.");
    const command = lifecycleCommand(prepared.command, prepared.receiptPath, instanceId);
    const child = (options.spawn ?? defaultSpawn)(command, prepared.directory);
    if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
      child.kill();
      throw new Error("Filesystem guard did not return a valid process id.");
    }
    const receipt: FsGuardLaunchReceipt = {
      schemaVersion: 1,
      owner: "vibebloat",
      kind: "fs-guard",
      pid: child.pid,
      directory: prepared.directory,
      command,
      instanceId,
      launchedAt: prepared.launchedAt,
    };
    try {
      applyAtomicFilePlans([{ path: prepared.receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600 }]);
      if (waitForProcessState(child.pid, instanceId, "owned", probeProcess, sleep, 500) !== "owned") {
        throw new Error("Filesystem guard process identity could not be verified.");
      }
      child.unref();
    } catch (error) {
      try {
        child.kill();
      } catch {}
      const state = probeProcess(child.pid, instanceId);
      if (state === "owned" || state === "unknown") {
        throw new Error("Filesystem guard launch failed and the child could not be stopped; receipt preserved for recovery.", { cause: error });
      }
      removeOwnedFileAtomically(prepared.receiptPath);
      throw error;
    }
    return receipt;
  });
}

export function stopPersistentFsGuard(options: FsGuardStopOptions): FsGuardStopReport {
  if (!isAbsolute(options.directory) || !existsSync(options.directory) || !statSync(options.directory).isDirectory()) {
    throw new Error("Filesystem guard directory must be an existing absolute directory.");
  }
  const directory = realpathSync(options.directory);
  const receiptPath = resolve(options.receiptPath ?? fsGuardReceiptPath(directory));
  const ownedRoot = join(directory, ".vibebloat");
  const receiptRelative = relative(ownedRoot, receiptPath);
  if (!receiptRelative || receiptRelative.startsWith("..") || isAbsolute(receiptRelative)) {
    throw new Error("Filesystem guard receipt must stay inside the repository .vibebloat directory.");
  }
  assertNoSymlinkedReceiptParent(ownedRoot, receiptPath);
  if (!existsSync(receiptPath)) return { stopped: false, staleReceipt: false };
  const probeProcess = options.probeProcess ?? defaultProbeProcess;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new Error("Filesystem guard stop timeout is invalid.");

  return withLifecycleLock(receiptPath, () => {
    if (lstatSync(receiptPath).isSymbolicLink()) throw new Error("Filesystem guard receipt cannot be a symbolic link.");
    const receipt = parseReceipt(readFileSync(receiptPath, "utf8"));
    if (receipt.directory !== directory) throw new Error("Filesystem guard receipt belongs to another repository.");
    const state = probeProcess(receipt.pid, receipt.instanceId);
    if (state === "foreign") throw new Error("Filesystem guard receipt PID belongs to another process; refusing to stop it.");
    if (state === "unknown") throw new Error("Filesystem guard process identity could not be verified; refusing to stop it.");
    if (state === "missing") {
      removeOwnedFileAtomically(receiptPath);
      removeOwnedFileAtomically(stopRequestPath(receiptPath));
      return { stopped: false, staleReceipt: true };
    }

    const requestPath = stopRequestPath(receiptPath);
    applyAtomicFilePlans([{ path: requestPath, content: `${JSON.stringify({ schemaVersion: 1, instanceId: receipt.instanceId }, null, 2)}\n`, mode: 0o600 }]);
    const finalState = options.probeProcess
      ? waitForProcessState(receipt.pid, receipt.instanceId, "missing", probeProcess, sleep, timeoutMs)
      : waitForOwnedProcessExit(receipt.pid, sleep, timeoutMs);
    if (finalState === "owned" || finalState === "unknown") throw new Error("Filesystem guard did not stop; receipt preserved for recovery.");
    removeOwnedFileAtomically(receiptPath);
    removeOwnedFileAtomically(requestPath);
    return { stopped: true, staleReceipt: false };
  });
}

function parseStopRequest(source: string): { schemaVersion: 1; instanceId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Filesystem guard stop request is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Filesystem guard stop request is malformed.");
  const request = parsed as Record<string, unknown>;
  if (Object.keys(request).sort().join(",") !== "instanceId,schemaVersion"
    || request.schemaVersion !== 1
    || typeof request.instanceId !== "string"
    || !instanceIdPattern.test(request.instanceId)) {
    throw new Error("Filesystem guard stop request is malformed.");
  }
  return request as unknown as { schemaVersion: 1; instanceId: string };
}

export function waitForFsGuardLaunchReceipt(options: FsGuardChildLifecycleOptions): FsGuardLaunchReceipt {
  if (!isAbsolute(options.directory) || !existsSync(options.directory) || !statSync(options.directory).isDirectory()) {
    throw new Error("Filesystem guard directory must be an existing absolute directory.");
  }
  if (!instanceIdPattern.test(options.instanceId)) throw new Error("Filesystem guard instance identity is invalid.");
  const directory = realpathSync(options.directory);
  const receiptPath = resolve(options.receiptPath ?? fsGuardReceiptPath(directory));
  const ownedRoot = join(directory, ".vibebloat");
  const receiptRelative = relative(ownedRoot, receiptPath);
  if (!receiptRelative || receiptRelative.startsWith("..") || isAbsolute(receiptRelative)) {
    throw new Error("Filesystem guard receipt must stay inside the repository .vibebloat directory.");
  }
  assertNoSymlinkedReceiptParent(ownedRoot, receiptPath);
  const pid = options.pid ?? process.pid;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
    throw new Error("Filesystem guard child lifecycle options are invalid.");
  }
  const attempts = Math.max(1, Math.ceil(timeoutMs / 25));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (existsSync(receiptPath)) {
      if (lstatSync(receiptPath).isSymbolicLink()) throw new Error("Filesystem guard receipt cannot be a symbolic link.");
      const receipt = parseReceipt(readFileSync(receiptPath, "utf8"));
      if (receipt.pid !== pid || receipt.instanceId !== options.instanceId || receipt.directory !== directory
        || !receipt.command.includes(`${instanceArgument}=${options.instanceId}`)
        || !receipt.command.includes(`${receiptArgument}=${receiptPath}`)) {
        throw new Error("Filesystem guard launch receipt does not match this process.");
      }
      return receipt;
    }
    if (attempt + 1 < attempts) sleep(25);
  }
  throw new Error("Filesystem guard launch receipt was not created; exiting to avoid an orphan.");
}

export function watchFsGuardStopRequests(options: FsGuardChildLifecycleOptions, onStop: () => void): FsGuardStopWatcher {
  const receipt = waitForFsGuardLaunchReceipt(options);
  const requestPath = stopRequestPath(resolve(options.receiptPath ?? fsGuardReceiptPath(receipt.directory)));
  let stopped = false;
  let watcher: FSWatcher;
  let poll: ReturnType<typeof setInterval>;
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    watcher.close();
  };
  const inspect = () => {
    if (stopped || !existsSync(requestPath) || lstatSync(requestPath).isSymbolicLink()) return;
    let request: { schemaVersion: 1; instanceId: string };
    try {
      request = parseStopRequest(readFileSync(requestPath, "utf8"));
    } catch {
      return;
    }
    if (request.instanceId !== receipt.instanceId) return;
    close();
    onStop();
  };
  watcher = watch(dirname(requestPath), { persistent: true }, (_eventType, filename) => {
    if (!filename || filename.toString() === "fs-guard.stop.json") inspect();
  });
  poll = setInterval(inspect, 50);
  queueMicrotask(inspect);
  return { close };
}

export function evaluateFsWrite(guards: Guard[], path: string, runtime = new Runtime()): HookResponse {
  return runFileGuard(guards, { chokepoint: "file", path }, runtime);
}

export function hasUnenforceableFileGuard(guards: Guard[]): boolean {
  return guards.some((guard) => guard.enabled && guard.match.chokepoint === "file" && guard.action.type !== "warn");
}

function guardedFileNames(guards: Guard[]): Set<string> {
  return new Set(guards.flatMap((guard) => {
    if (!guard.enabled || guard.match.chokepoint !== "file" || guard.action.type === "warn") return [];
    const path = guard.match.path;
    return path && path === path.replaceAll("\\", "/").replace(/^.*\//, "") ? [path] : [];
  }));
}

function snapshotGuardedFile(path: string): GuardedFileSnapshot {
  if (!existsSync(path)) return { existed: false };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Guarded file target must be a regular file.");
  return { existed: true, content: readFileSync(path), mode: stat.mode };
}

function ensureOwnedQuarantineDirectory(root: string): string {
  let current = root;
  for (const segment of [".vibebloat", "quarantine", "fs-guard"]) {
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Filesystem guard quarantine path is unsafe.");
  }
  return current;
}

function recoverGuardedFile(path: string, snapshot: GuardedFileSnapshot, quarantineDirectory: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Guarded write target changed type during recovery.");
    renameSync(path, join(quarantineDirectory, `${path.replace(/^.*[\\/]/, "")}.${randomUUID()}.rejected`));
  }
  if (snapshot.existed) applyAtomicFilePlans([{ path, content: snapshot.content!, mode: snapshot.mode }]);
}

export function watchGuardedWrites(directory: string, guards: Guard[], onDetected: (path: string, response: HookResponse) => void, runtime = new Runtime()): FSWatcher {
  const root = realpathSync(resolve(directory));
  if (!statSync(root).isDirectory()) throw new Error("Filesystem guard root must be a directory.");
  const guarded = guardedFileNames(guards);
  const snapshots = new Map([...guarded].map((name) => [name, snapshotGuardedFile(join(root, name))]));
  const quarantineDirectory = guarded.size > 0 ? ensureOwnedQuarantineDirectory(root) : undefined;
  const recovering = new Set<string>();
  return watch(root, { persistent: true }, (_eventType, filename) => {
    if (!filename) return;
    const name = filename.toString().replaceAll("\\", "/").replace(/^.*\//, "");
    if (recovering.has(name)) return;
    const response = evaluateFsWrite(guards, name, runtime);
    const snapshot = snapshots.get(name);
    if (response.exitCode === 2 && snapshot) {
      recovering.add(name);
      try {
        recoverGuardedFile(join(root, name), snapshot, quarantineDirectory!);
        onDetected(name, response);
      } finally {
        setTimeout(() => recovering.delete(name), 50);
      }
      return;
    }
    if (snapshot) snapshots.set(name, snapshotGuardedFile(join(root, name)));
  });
}

export function closeWatcherOnSignals(watcher: Pick<FSWatcher, "close">, signals: SignalSource = process, onClose = () => {}): () => void {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signals.off("SIGINT", close);
    signals.off("SIGTERM", close);
    watcher.close();
    onClose();
  };
  signals.once("SIGINT", close);
  signals.once("SIGTERM", close);
  return close;
}
