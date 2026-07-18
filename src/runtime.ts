import { canonicalGuardId, compatiblePersistedGuardIds } from "./guards";
import { match } from "./match";
import { withGitAliases } from "./normalization/git-aliases";
import type { Event, Guard, Verdict } from "./types";
import type { FiringMetadata } from "./audit/firings";
import { runAction } from "./runtime/actions";
import type { ActionContext } from "./runtime/actions/types";
import type { LocalWarning } from "./types";

export type OverrideConsumer = (guardId: string) => boolean;
export type EventNormalizer = (event: Event) => Event;
export type FiringRecorder = (metadata: FiringMetadata) => readonly LocalWarning[] | void;

export class Runtime {
  private readonly overrides = new Set<string>();
  private readonly disabled = new Set<string>();

  constructor(
    disabledGuardIds: Iterable<string> = [],
    private readonly consumePersistedOverride?: OverrideConsumer,
    private readonly normalizeEvent: EventNormalizer = withGitAliases,
    private readonly recordFiring?: FiringRecorder,
  ) {
    for (const guardId of disabledGuardIds) this.disabled.add(canonicalGuardId(guardId));
  }

  allowOnce(guardId: string): void {
    this.overrides.add(canonicalGuardId(guardId));
  }

  disable(guardId: string): void {
    this.disabled.add(canonicalGuardId(guardId));
  }

  evaluate(guards: Guard[], event: Event, context: ActionContext = {}): Verdict {
    const normalizedEvent = this.normalizeEvent(event);
    for (const guard of guards) {
      const guardId = canonicalGuardId(guard.id);
      if (this.disabled.has(guardId)) continue;
      if (guard.binds?.length && context.agent && !guard.binds.includes(context.agent)) continue;
      const verdict = match(guard, normalizedEvent);
      if (!verdict.fired) continue;
      if (this.overrides.delete(guardId) || compatiblePersistedGuardIds(guardId).some((id) => this.consumePersistedOverride?.(id))) return { fired: false };
      const outcome = runAction(guard, normalizedEvent, context);
      let auditWarnings: LocalWarning[] = [];
      try {
        auditWarnings = [...(this.recordFiring?.({
          guardId,
          class: guard.class,
          chokepoint: normalizedEvent.chokepoint,
          actionType: guard.action.type,
          blocked: outcome.blocked,
          ...(context.agent ? { agent: context.agent } : {}),
        }) ?? [])];
      } catch {
        auditWarnings = [{
          what: "Firing audit update stopped.",
          why: "Local firing audit storage failed.",
          fix: "vibebloat doctor",
        }];
      }
      return {
        ...verdict,
        ...outcome,
        actionType: guard.action.type,
        ...(auditWarnings.length ? { auditWarnings } : {}),
      };
    }
    return { fired: false };
  }
}
