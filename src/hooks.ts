import { Runtime } from "./runtime";
import type { Event, Guard } from "./types";

export interface HookResponse {
  exitCode: 0 | 2;
  stderr?: string;
}

export function runPreToolUse(guards: Guard[], payload: unknown, runtime = new Runtime()): HookResponse {
  const command = (payload as { tool_input?: { command?: unknown } })?.tool_input?.command;
  if (typeof command !== "string") return { exitCode: 0 };
  const verdict = runtime.evaluate(guards, { chokepoint: "shell", command });
  return verdict.fired ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}

export function runFileGuard(guards: Guard[], event: Event, runtime = new Runtime()): HookResponse {
  const verdict = runtime.evaluate(guards, event);
  return verdict.fired ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}
