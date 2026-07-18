import { canonicalGuardId, compatiblePersistedGuardIds } from "./guards";
import { match } from "./match";
import type { Event, Guard, Verdict } from "./types";
import { runAction } from "./runtime/actions";
import type { ActionContext } from "./runtime/actions/types";

export type OverrideConsumer = (guardId: string) => boolean;

export class Runtime {
  private readonly overrides = new Set<string>();
  private readonly disabled = new Set<string>();

  constructor(disabledGuardIds: Iterable<string> = [], private readonly consumePersistedOverride?: OverrideConsumer) {
    for (const guardId of disabledGuardIds) this.disabled.add(canonicalGuardId(guardId));
  }

  allowOnce(guardId: string): void {
    this.overrides.add(canonicalGuardId(guardId));
  }

  disable(guardId: string): void {
    this.disabled.add(canonicalGuardId(guardId));
  }

  evaluate(guards: Guard[], event: Event, context: ActionContext = {}): Verdict {
    for (const guard of guards) {
      const guardId = canonicalGuardId(guard.id);
      if (this.disabled.has(guardId)) continue;
      const verdict = match(guard, event);
      if (!verdict.fired) continue;
      if (this.overrides.delete(guardId) || compatiblePersistedGuardIds(guardId).some((id) => this.consumePersistedOverride?.(id))) return { fired: false };
      return { ...verdict, ...runAction(guard, event, context), actionType: guard.action.type };
    }
    return { fired: false };
  }
}
