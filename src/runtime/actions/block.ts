import type { ActionOutcome } from "./types";

export function block(message: string): ActionOutcome {
  return { blocked: true, reason: message };
}
