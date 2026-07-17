import type { ActionOutcome } from "./types";

export function runCheck(message: string, passed: boolean): ActionOutcome {
  return passed ? { blocked: false, reason: message } : { blocked: true, reason: message };
}
