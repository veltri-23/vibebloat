import type { ActionOutcome } from "./types";

export function requireConfirm(message: string, confirmed: boolean): ActionOutcome {
  return confirmed ? { blocked: false, reason: message } : { blocked: true, reason: message };
}
