export type GuardClass = "A" | "B" | "C" | "D";
export type Chokepoint = "shell" | "file";
export type GuardAgent = "claude-code" | "codex" | "hermes" | "openclaw";
export type ActionType = "block" | "warn" | "require-confirm" | "quarantine-file" | "run-check";

interface ActionBase {
  message: string;
  override: string;
}

export type Action =
  | (ActionBase & { type: "block" })
  | (ActionBase & { type: "warn" })
  | (ActionBase & { type: "require-confirm" })
  | (ActionBase & { type: "quarantine-file"; quarantinePath?: string })
  | (ActionBase & { type: "run-check"; check: string });

export interface Guard {
  schemaVersion?: 1;
  id: string;
  class: GuardClass;
  provenance: { incident: string; date: string; source: string };
  match: {
    chokepoint: Chokepoint;
    command?: string;
    argsContains?: string[];
    argsAnyOf?: string[];
    path?: string;
    // Situational scoping: the command/file is only dangerous in a specific
    // context. When present, every stated condition must hold or the guard does
    // not fire -- so the same command runs untouched everywhere else. This is
    // what makes a guard "block the recurrence of a mistake" instead of a
    // command-class blocklist.
    context?: MatchContext;
  };
  action: Action;
  confidence?: "high" | "low";
  tier?: "local" | "community";
  binds?: GuardAgent[];
  enabled: boolean;
}

export interface MatchContext {
  // The command is only guarded when the working directory is inside this path.
  cwdUnder?: string;
  // ...and a process whose name contains this string is currently running.
  whenProcessRunning?: string;
  // ...and the repo has uncommitted/unstaged changes that would be lost.
  whenUnstagedChanges?: boolean;
}

export interface Event {
  chokepoint: Chokepoint;
  command?: string;
  path?: string;
  variables?: Record<string, string>;
  aliases?: Record<string, string>;
  aliasResolutionFailed?: boolean;
  // Runtime facts gathered at enforcement time, consumed by match.context.
  // Absent facts mean "unknown" -- a situational guard will not fire when it
  // cannot confirm its situation, which keeps false positives near zero.
  cwd?: string;
  runningProcesses?: string[];
  hasUnstagedChanges?: boolean;
}

export interface Verdict {
  fired: boolean;
  guardId?: string;
  reason?: string;
  parseError?: boolean;
  blocked?: boolean;
  warning?: string;
  quarantinedPath?: string;
  actionType?: ActionType;
  receipt?: string;
  auditWarnings?: LocalWarning[];
}

export interface LocalWarning {
  what: string;
  why: string;
  fix: string;
}
