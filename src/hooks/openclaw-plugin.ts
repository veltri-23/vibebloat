import { evaluatePreToolUse } from "../hooks";
import { guardDirectories } from "../guard-home";
import { loadGuards } from "../guard-loader";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../guards";
import { withGitAliases } from "../normalization/git-aliases";
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

export function beforeToolCall(guards: Guard[], event: BeforeToolCallEvent, runtime = new Runtime()): BeforeToolCallResult | undefined {
  const verdict = evaluatePreToolUse(guards, payloadFor(event), runtime);
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

const builtInGuards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];

export function runtimeGuards(environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Guard[] {
  const installed = guardDirectories(environment, cwd).flatMap(loadGuards);
  const seenIds = new Set(builtInGuards.map((guard) => guard.id));
  const duplicate = installed.find((guard) => seenIds.has(guard.id) || !seenIds.add(guard.id));
  if (duplicate) throw new Error(`Installed guard duplicates built-in id: ${duplicate.id}`);
  return [...builtInGuards, ...installed];
}

export function guardedBeforeToolCall(
  event: BeforeToolCallEvent,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): BeforeToolCallResult | undefined {
  try {
    return beforeToolCall(
      runtimeGuards(environment, cwd),
      event,
      new Runtime([], undefined, (input) => withGitAliases(input, { cwd, environment })),
    );
  } catch (error) {
    return {
      block: true,
      blockReason: `Guard runtime failed closed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  }
}

const openClawPlugin = {
  id: "vibebloat",
  name: "VibeBloat",
  description: "Blocks known agent failure modes before tool execution.",
  register(api: OpenClawApi): void {
    api.on("before_tool_call", (event) => guardedBeforeToolCall(event));
  },
};

export default openClawPlugin;
