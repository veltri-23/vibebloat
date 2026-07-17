import type { ActionOutcome } from "./types";

export function warn(message: string): ActionOutcome {
  return { blocked: false, reason: message, warning: message };
}
