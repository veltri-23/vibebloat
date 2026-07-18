import { existsSync, lstatSync, readFileSync, realpathSync, statSync, watch, type FSWatcher } from "node:fs";
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
  isProcessAlive?: (pid: number) => boolean;
  now?: Date;
}

function defaultSpawn(command: readonly string[], cwd: string): DetachedFsGuardProcess {
  return Bun.spawn([...command], {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  }) as DetachedFsGuardProcess;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  if (keys !== "command,directory,kind,launchedAt,owner,pid,schemaVersion"
    || receipt.schemaVersion !== 1
    || receipt.owner !== "vibebloat"
    || receipt.kind !== "fs-guard"
    || !Number.isSafeInteger(receipt.pid) || (receipt.pid as number) <= 0
    || typeof receipt.directory !== "string" || !isAbsolute(receipt.directory)
    || !Array.isArray(receipt.command) || receipt.command.length < 3 || receipt.command.some((part) => typeof part !== "string" || !part)
    || typeof receipt.launchedAt !== "string" || Number.isNaN(Date.parse(receipt.launchedAt))) {
    throw new Error("Filesystem guard receipt is not VibeBloat-owned; refusing to overwrite it.");
  }
  return receipt as unknown as FsGuardLaunchReceipt;
}

export function fsGuardReceiptPath(repository: string): string {
  return join(resolve(repository), ".vibebloat", "receipts", "fs-guard.json");
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

export function launchPersistentFsGuard(options: FsGuardLaunchOptions): FsGuardLaunchReceipt {
  const prepared = preflightLaunch(options);
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (existsSync(prepared.receiptPath)) {
    if (lstatSync(prepared.receiptPath).isSymbolicLink()) throw new Error("Filesystem guard receipt cannot be a symbolic link.");
    const existing = parseReceipt(readFileSync(prepared.receiptPath, "utf8"));
    if (isProcessAlive(existing.pid)) {
      if (existing.directory === prepared.directory && JSON.stringify(existing.command) === JSON.stringify(prepared.command)) return existing;
      throw new Error("A different VibeBloat filesystem guard is still running; refusing to orphan it.");
    }
  }

  const child = (options.spawn ?? defaultSpawn)(prepared.command, prepared.directory);
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) {
    child.kill();
    throw new Error("Filesystem guard did not return a valid process id.");
  }
  try {
    child.unref();
  } catch (error) {
    child.kill();
    throw error;
  }
  const receipt: FsGuardLaunchReceipt = {
    schemaVersion: 1,
    owner: "vibebloat",
    kind: "fs-guard",
    pid: child.pid,
    directory: prepared.directory,
    command: prepared.command,
    launchedAt: prepared.launchedAt,
  };
  try {
    applyAtomicFilePlans([{ path: prepared.receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600 }]);
  } catch (error) {
    child.kill();
    throw error;
  }
  return receipt;
}

export function evaluateFsWrite(guards: Guard[], path: string, runtime = new Runtime()): HookResponse {
  return runFileGuard(guards, { chokepoint: "file", path }, runtime);
}

export function hasUnenforceableFileGuard(guards: Guard[]): boolean {
  return guards.some((guard) => guard.enabled && guard.match.chokepoint === "file" && guard.action.type !== "warn");
}

export function watchGuardedWrites(directory: string, guards: Guard[], onDetected: (path: string, response: HookResponse) => void, runtime = new Runtime()): FSWatcher {
  return watch(directory, { persistent: true }, (_eventType, filename) => {
    if (!filename) return;
    const response = evaluateFsWrite(guards, filename.toString(), runtime);
    if (response.exitCode === 2) onDetected(filename.toString(), response);
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
