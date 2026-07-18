import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mcpConfigWrongFileGuard } from "../src/guards";
import { closeWatcherOnSignals, evaluateFsWrite, hasUnenforceableFileGuard, watchGuardedWrites } from "../src/install/fs-guard";

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
