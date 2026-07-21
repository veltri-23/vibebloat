import { canonicalGuardId, compatiblePersistedGuardIds } from "./guards";
import { match } from "./match";
import { withGitAliases } from "./normalization/git-aliases";
import { narrateRecallHit, recallWarnThreshold, type SemanticRecall, type SyncSemanticRecall } from "./ingest/semantic-recall";
import type { Event, Guard, Verdict } from "./types";
import type { FiringMetadata } from "./audit/firings";
import { runAction } from "./runtime/actions";
import type { ActionContext } from "./runtime/actions/types";
import type { LocalWarning } from "./types";
import { renderGuardReceipt } from "./block-receipt";

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
    private readonly recall?: SyncSemanticRecall,
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
      if (this.overrides.delete(guardId) || compatiblePersistedGuardIds(guardId).some((id) => this.consumePersistedOverride?.(id))) continue;
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
        ...(outcome.reason ? { receipt: renderGuardReceipt(guard, outcome.reason) } : {}),
        ...(auditWarnings.length ? { auditWarnings } : {}),
      };
    }
    return this.recall ? this.recallAdvisorySync(normalizedEvent) ?? { fired: false } : { fired: false };
  }

  /**
   * Sync recall path. Only the lexical + off backends fit here; the async
   * embed backend composes via `recallAdvisory` below. Keeps the enforcement
   * hot path synchronous — embed callers do the network call at scan time,
   * not at chokepoint time.
   */
  private recallAdvisorySync(event: Event): { fired: false; warning?: string; blocked?: false } | undefined {
    if (!this.recall || !event.command) return undefined;
    const canonical = event.command;
    const hits = this.recall.recall({ event, canonicalCommand: canonical, limit: 1 });
    const top = hits[0];
    if (!top || top.similarity < (this.recall.warnThreshold ?? recallWarnThreshold)) return undefined;
    return { fired: false, warning: narrateRecallHit(top, event.cwd) };
  }

  /**
   * Async side door for backends that need network I/O. Returns null when no
   * advisory is warranted. Callers wire this into their pre-tool path; it
   * does NOT block the synchronous evaluate() loop.
   */
  async recallAdvisory(event: Event, recall?: SemanticRecall): Promise<{ warning: string; similarity: number; incidentId: string } | null> {
    const adapter = recall ?? this.recall;
    if (!adapter || !event.command) return null;
    const normalizedEvent = this.normalizeEvent(event);
    const canonical = normalizedEvent.command ?? event.command;
    const hits = await adapter.recall({ event: normalizedEvent, canonicalCommand: canonical, limit: 1 });
    const top = hits[0];
    if (!top || top.similarity < (adapter.warnThreshold ?? recallWarnThreshold)) return null;
    return { warning: narrateRecallHit(top, normalizedEvent.cwd), similarity: top.similarity, incidentId: top.incidentId };
  }
}
