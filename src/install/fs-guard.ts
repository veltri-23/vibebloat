import { watch, type FSWatcher } from "node:fs";
import { runFileGuard, type HookResponse } from "../hooks";
import { Runtime } from "../runtime";
import type { Guard } from "../types";

export interface SignalSource {
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function evaluateFsWrite(guards: Guard[], path: string, runtime = new Runtime()): HookResponse {
  return runFileGuard(guards, { chokepoint: "file", path }, runtime);
}

export function hasUnenforceableFileGuard(guards: Guard[]): boolean {
  return guards.some((guard) => guard.enabled && guard.match.chokepoint === "file" && guard.action.type !== "warn");
}

export function watchGuardedWrites(directory: string, guards: Guard[], onDetected: (path: string, response: HookResponse) => void, runtime = new Runtime()): FSWatcher {
  if (hasUnenforceableFileGuard(guards)) {
    throw new Error("fs.watch observes writes after they occur and cannot enforce active file guards");
  }
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
