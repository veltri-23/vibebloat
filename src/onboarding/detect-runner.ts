export type RunnerKind = "agent" | "human";

export interface RunnerSignals {
  explicit?: RunnerKind;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  parentProcess: string;
}

const agentEnvironment = ["CLAUDE_CODE_ENTRYPOINT", "CODEX_HOME", "OPENCLAW_SESSION", "HERMES_HOME"];
const agentParents = /(?:claude|codex|openclaw|hermes)/i;

export function detectRunner(signals: RunnerSignals): RunnerKind {
  if (signals.explicit) return signals.explicit;
  if (agentEnvironment.some((name) => signals.env[name])) return "agent";
  if (agentParents.test(signals.parentProcess)) return "agent";
  return signals.isTTY ? "human" : "agent";
}
