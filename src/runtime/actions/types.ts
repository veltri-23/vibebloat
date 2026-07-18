import type { Event, Guard, GuardAgent } from "../../types";

export interface ActionContext {
  agent?: GuardAgent;
  confirm?: (guard: Guard, event: Event) => boolean;
  checks?: Record<string, (guard: Guard, event: Event) => boolean>;
}

export interface ActionOutcome {
  blocked: boolean;
  reason: string;
  warning?: string;
  quarantinedPath?: string;
}
