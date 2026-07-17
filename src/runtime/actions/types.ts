import type { Event, Guard } from "../../types";

export interface ActionContext {
  confirm?: (guard: Guard, event: Event) => boolean;
  checks?: Record<string, (guard: Guard, event: Event) => boolean>;
}

export interface ActionOutcome {
  blocked: boolean;
  reason: string;
  warning?: string;
  quarantinedPath?: string;
}
