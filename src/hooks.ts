import { Runtime } from "./runtime";
import type { Event, Guard } from "./types";

export interface HookResponse {
  exitCode: 0 | 2;
  stderr?: string;
}

export function runPreToolUse(guards: Guard[], payload: unknown, runtime = new Runtime()): HookResponse {
  const hookPayload = payload as {
    tool_input?: { command?: unknown; file_path?: unknown; path?: unknown };
    toolInput?: { command?: unknown; file_path?: unknown; path?: unknown };
    tool_name?: unknown;
    toolName?: unknown;
  };
  const toolInput = hookPayload.tool_input ?? hookPayload.toolInput;
  const command = toolInput?.command;
  const path = toolInput?.file_path ?? toolInput?.path;
  const toolName = hookPayload.tool_name ?? hookPayload.toolName;
  const fileGuard = typeof command === "string" && toolName === "apply_patch"
    ? guards.find((guard) => guard.match.chokepoint === "file" && guard.match.path && command.includes(guard.match.path))
    : undefined;
  const event = typeof command === "string"
    ? fileGuard
      ? { chokepoint: "file" as const, path: fileGuard.match.path }
      : { chokepoint: "shell" as const, command }
    : typeof path === "string"
      ? { chokepoint: "file" as const, path }
      : undefined;
  if (!event) return { exitCode: 0 };
  const verdict = runtime.evaluate(fileGuard ? [fileGuard] : guards, event);
  return verdict.fired ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}

export function runFileGuard(guards: Guard[], event: Event, runtime = new Runtime()): HookResponse {
  const verdict = runtime.evaluate(guards, event);
  return verdict.fired ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}
