import { expect, test } from "bun:test";
import { mcpConfigWrongFileGuard } from "../src/guards";
import { closeWatcherOnSignals, evaluateFsWrite } from "../src/install/fs-guard";

test("filesystem fallback blocks wrong MCP config write", () => {
  expect(evaluateFsWrite([mcpConfigWrongFileGuard], "C:/repo/.mcp.json")).toMatchObject({ exitCode: 2 });
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
