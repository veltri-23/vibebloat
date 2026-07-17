import { evaluatePreToolUse } from "../hooks";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../guards";
import { Runtime } from "../runtime";
import type { Guard } from "../types";

export interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  derivedPaths?: string[];
}

export interface BeforeToolCallResult {
  block?: boolean;
  blockReason?: string;
  requireApproval?: {
    title: string;
    description: string;
    severity: "warning";
    timeoutMs: number;
    timeoutBehavior: "deny";
    allowedDecisions: ["allow-once", "deny"];
  };
}

interface OpenClawApi {
  on(name: "before_tool_call", handler: (event: BeforeToolCallEvent) => BeforeToolCallResult | undefined): void;
}

function payloadFor(event: BeforeToolCallEvent): unknown {
  const command = event.params.command;
  const path = event.derivedPaths?.[0] ?? event.params.file_path ?? event.params.path;
  return {
    tool_name: event.toolName,
    tool_input: typeof command === "string"
      ? { command }
      : typeof path === "string"
        ? { file_path: path }
        : {},
  };
}

export function beforeToolCall(guards: Guard[], event: BeforeToolCallEvent): BeforeToolCallResult | undefined {
  const verdict = evaluatePreToolUse(guards, payloadFor(event), new Runtime());
  if (!verdict.fired) return undefined;
  if (verdict.actionType === "require-confirm") {
    return {
      requireApproval: {
        title: "VibeBloat confirmation",
        description: verdict.reason ?? "Confirm this guarded action.",
        severity: "warning",
        timeoutMs: 600_000,
        timeoutBehavior: "deny",
        allowedDecisions: ["allow-once", "deny"],
      },
    };
  }
  return verdict.blocked ? { block: true, blockReason: verdict.reason } : undefined;
}

const guards = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];

const openClawPlugin = {
  id: "vibebloat",
  name: "VibeBloat",
  description: "Blocks known agent failure modes before tool execution.",
  register(api: OpenClawApi): void {
    api.on("before_tool_call", (event) => beforeToolCall(guards, event));
  },
};

export default openClawPlugin;
