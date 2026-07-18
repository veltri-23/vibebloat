import { Runtime } from "./runtime";
import type { Event, Guard, GuardAgent, Verdict } from "./types";

export interface HookResponse {
  exitCode: 0 | 2;
  stderr?: string;
}

interface HookBinding {
  event: Event;
  guards: Guard[];
}

export function bindingFromPreToolUse(guards: Guard[], payload: unknown, agent?: GuardAgent): HookBinding | undefined {
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
  const applicableGuards = agent ? guards.filter((guard) => !guard.binds?.length || guard.binds.includes(agent)) : guards;
  const fileGuard = typeof command === "string" && toolName === "apply_patch"
    ? applicableGuards.find((guard) => guard.match.chokepoint === "file" && guard.match.path && command.includes(guard.match.path))
    : undefined;
  const event = typeof command === "string"
    ? fileGuard
      ? { chokepoint: "file" as const, path: fileGuard.match.path }
      : { chokepoint: "shell" as const, command }
    : typeof path === "string"
      ? { chokepoint: "file" as const, path }
      : undefined;
  return event ? { event, guards: fileGuard ? [fileGuard] : applicableGuards } : undefined;
}

export function evaluatePreToolUse(guards: Guard[], payload: unknown, runtime = new Runtime(), agent?: GuardAgent): Verdict {
  const binding = bindingFromPreToolUse(guards, payload, agent);
  return binding ? runtime.evaluate(binding.guards, binding.event, { agent }) : { fired: false };
}

export function runPreToolUse(guards: Guard[], payload: unknown, runtime = new Runtime(), agent?: GuardAgent): HookResponse {
  const verdict = evaluatePreToolUse(guards, payload, runtime, agent);
  return verdict.blocked ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}

export function runFileGuard(guards: Guard[], event: Event, runtime = new Runtime()): HookResponse {
  const verdict = runtime.evaluate(guards, event);
  return verdict.blocked ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}
