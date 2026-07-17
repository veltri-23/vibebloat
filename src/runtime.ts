import { match } from "./match";
import type { Event, Guard, Verdict } from "./types";
import { runAction } from "./runtime/actions";
import type { ActionContext } from "./runtime/actions/types";

export class Runtime {
  private readonly overrides = new Set<string>();
  private readonly disabled = new Set<string>();

  constructor(disabledGuardIds: Iterable<string> = []) {
    for (const guardId of disabledGuardIds) this.disabled.add(guardId);
  }

  allowOnce(guardId: string): void {
    this.overrides.add(guardId);
  }

  disable(guardId: string): void {
    this.disabled.add(guardId);
  }

  evaluate(guards: Guard[], event: Event, context: ActionContext = {}): Verdict {
    for (const guard of guards) {
      if (this.disabled.has(guard.id)) continue;
      const verdict = match(guard, event);
      if (!verdict.fired) continue;
      if (this.overrides.delete(guard.id)) return { fired: false };
      return { ...verdict, ...runAction(guard, event, context), actionType: guard.action.type };
    }
    return { fired: false };
  }
}
