export type GuardClass = "A" | "B" | "C" | "D";
export type Chokepoint = "shell" | "file";

export interface Guard {
  id: string;
  class: GuardClass;
  provenance: { incident: string; date: string; source: string };
  match: {
    chokepoint: Chokepoint;
    command?: string;
    argsContains?: string[];
    path?: string;
  };
  action: { type: "block"; message: string; override: string };
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
}
