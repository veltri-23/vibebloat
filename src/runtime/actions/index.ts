import type { Event, Guard } from "../../types";
import { block } from "./block";
import { quarantineFile } from "./quarantine-file";
import { requireConfirm } from "./require-confirm";
import { runCheck } from "./run-check";
import type { ActionContext, ActionOutcome } from "./types";
import { warn } from "./warn";

export function runAction(guard: Guard, event: Event, context: ActionContext = {}): ActionOutcome {
  switch (guard.action.type) {
    case "block":
      return block(guard.action.message);
    case "warn":
      return warn(guard.action.message);
    case "require-confirm":
      return requireConfirm(guard.action.message, context.confirm?.(guard, event) === true);
    case "quarantine-file":
      return quarantineFile(event.path, guard.action.quarantinePath, guard.action.message);
    case "run-check":
      return runCheck(guard.action.message, context.checks?.[guard.action.check]?.(guard, event) === true);
  }
}
