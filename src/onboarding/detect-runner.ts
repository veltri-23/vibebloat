export type RunnerKind = "agent" | "human";
export type RunnerDetectionSource = "explicit" | "environment" | "parent-process" | "tty" | "non-interactive";

export interface RunnerDetection {
  kind: RunnerKind;
  source: RunnerDetectionSource;
}

export interface RunnerSignals {
  explicit?: RunnerKind;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  parentProcess: string;
}

const agentEnvironment = ["CLAUDE_CODE_ENTRYPOINT", "CODEX_HOME", "OPENCLAW_SESSION", "HERMES_HOME"];
const agentParents = /(?:claude|codex|openclaw|hermes)/i;

export function detectRunner(signals: RunnerSignals): RunnerKind {
  return detectRunnerDetails(signals).kind;
}

export function detectRunnerDetails(signals: RunnerSignals): RunnerDetection {
  if (signals.explicit) return { kind: signals.explicit, source: "explicit" };
  if (agentEnvironment.some((name) => signals.env[name])) return { kind: "agent", source: "environment" };
  if (agentParents.test(signals.parentProcess)) return { kind: "agent", source: "parent-process" };
  return signals.isTTY ? { kind: "human", source: "tty" } : { kind: "agent", source: "non-interactive" };
}

export function parseRunnerOverride(args: readonly string[]): RunnerKind | undefined {
  const agent = args.includes("--agent");
  const human = args.includes("--human");
  if (agent && human) throw new Error("choose either --agent or --human, not both");
  return agent ? "agent" : human ? "human" : undefined;
}

export function parentProcessCommand(parentId = process.ppid, platform = process.platform): string {
  if (!parentId) return "";
  const command = platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${parentId}').CommandLine`]
    : ["ps", "-p", String(parentId), "-o", "args="];
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : "";
  } catch {
    return "";
  }
}
