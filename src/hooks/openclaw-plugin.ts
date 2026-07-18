import { createFiringRecorder } from "../audit/firings";
import { evaluatePreToolUse, formatAuditWarning, formatGuardRuntimeFailure } from "../hooks";
import { globalGuardHome, guardDirectories } from "../guard-home";
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
  localWarning?: string;
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
  const verdict = evaluatePreToolUse(guards, payloadFor(event), runtime, "openclaw");
  const localWarning = formatAuditWarning(verdict.auditWarnings);
  if (!verdict.fired) return undefined;
  if (verdict.actionType === "require-confirm") {
    return {
      ...(localWarning ? { localWarning } : {}),
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
  if (verdict.blocked) return { block: true, blockReason: verdict.reason, ...(localWarning ? { localWarning } : {}) };
  return localWarning ? { localWarning } : undefined;
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
      new Runtime(
        [],
        undefined,
        (input) => withGitAliases(input, { cwd, environment }),
        createFiringRecorder(globalGuardHome(environment)),
      ),
    );
  } catch {
    return {
      block: true,
      blockReason: formatGuardRuntimeFailure("OpenClaw guard evaluation stopped"),
    };
  }
}

const openClawPlugin = {
  id: "vibebloat",
  name: "VibeBloat",
  description: "Blocks known agent failure modes before tool execution.",
  register(api: OpenClawApi): void {
    api.on("before_tool_call", (event) => {
      const result = guardedBeforeToolCall(event);
      if (!result?.localWarning) return result;
      process.stderr.write(`${result.localWarning}\n`);
      const { localWarning: _warning, ...response } = result;
      return Object.keys(response).length ? response : undefined;
    });
  },
};

export default openClawPlugin;
