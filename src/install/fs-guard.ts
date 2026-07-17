import { watch, type FSWatcher } from "node:fs";
import { runFileGuard, type HookResponse } from "../hooks";
import { Runtime } from "../runtime";
import type { Guard } from "../types";

export function evaluateFsWrite(guards: Guard[], path: string, runtime = new Runtime()): HookResponse {
  return runFileGuard(guards, { chokepoint: "file", path }, runtime);
}

export function watchGuardedWrites(directory: string, guards: Guard[], onBlocked: (path: string, response: HookResponse) => void): FSWatcher {
  return watch(directory, { persistent: false }, (_eventType, filename) => {
    if (!filename) return;
    const response = evaluateFsWrite(guards, filename.toString());
    if (response.exitCode === 2) onBlocked(filename.toString(), response);
  });
}
