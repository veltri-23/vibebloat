import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfigWrongFileGuard } from "../src/guards";
import { closeWatcherOnSignals, evaluateFsWrite, fsGuardReceiptPath, hasUnenforceableFileGuard, launchPersistentFsGuard, watchGuardedWrites } from "../src/install/fs-guard";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("filesystem guard evaluation identifies wrong MCP config writes", () => {
  expect(evaluateFsWrite([mcpConfigWrongFileGuard], "C:/repo/.mcp.json")).toMatchObject({ exitCode: 2 });
});

test("filesystem watcher observes block guards without claiming pre-write enforcement", () => {
  expect(hasUnenforceableFileGuard([mcpConfigWrongFileGuard])).toBe(true);
  const watcher = watchGuardedWrites(import.meta.dir, [mcpConfigWrongFileGuard], () => {});
  watcher.close();
});

test("filesystem watcher reports a guarded write after the filesystem event", async () => {
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
  const spawn = () => {
    spawns += 1;
    return { pid: 4242, unref: () => { unrefs += 1; }, kill: () => {} };
  };

  const first = launchPersistentFsGuard({ directory, command, spawn, isProcessAlive: () => true, now: new Date("2026-07-18T12:00:00Z") });
  const second = launchPersistentFsGuard({ directory, command, spawn, isProcessAlive: () => true });

  expect(second).toEqual(first);
  expect({ spawns, unrefs }).toEqual({ spawns: 1, unrefs: 1 });
  expect(JSON.parse(readFileSync(fsGuardReceiptPath(directory), "utf8"))).toEqual(first);
});

test("persistent filesystem guard replaces a stale owned receipt", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-fs-launch-"));
  temporaryDirectories.push(directory);
  const receiptPath = fsGuardReceiptPath(directory);
  const command = [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "watch", directory];
  let killed = false;
  launchPersistentFsGuard({ directory, command, spawn: () => ({ pid: 41, unref: () => {}, kill: () => {} }), isProcessAlive: () => false });
  const receipt = launchPersistentFsGuard({
    directory,
    command,
    spawn: () => ({ pid: 42, unref: () => {}, kill: () => { killed = true; } }),
    isProcessAlive: () => false,
  });
  expect(receipt.pid).toBe(42);
  expect(JSON.parse(readFileSync(receiptPath, "utf8")).pid).toBe(42);
  expect(killed).toBeFalse();
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
