export type GuardClass = "A" | "B" | "C" | "D";
export type Chokepoint = "shell" | "file";
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
  binds?: string[];
  enabled: boolean;
}

export interface Event {
  chokepoint: Chokepoint;
  command?: string;
  path?: string;
  variables?: Record<string, string>;
  aliases?: Record<string, string>;
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
}
