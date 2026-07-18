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
  };
  action: Action;
  confidence?: "high" | "low";
  tier?: "local" | "community";
  binds?: GuardAgent[];
  enabled: boolean;
}

export interface Event {
  chokepoint: Chokepoint;
  command?: string;
  path?: string;
  variables?: Record<string, string>;
  aliases?: Record<string, string>;
  aliasResolutionFailed?: boolean;
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
