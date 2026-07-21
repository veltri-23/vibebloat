import { type IncidentStore, type StoredIncident } from "./incidents-store";
import {
  type RecallHit,
  type RecallRequest,
  type SemanticRecall,
  commandSignature,
  commandTokens,
  jaccardSimilarity,
} from "./semantic-recall";

const maximumCandidates = 64;

export interface LexicalRecallOptions {
  store: IncidentStore;
  /** Cache the empty-store check so an empty DB stays O(1) on every call. */
  emptyCacheMs?: number;
  now?: () => Date;
}

interface CacheState {
  emptyExpiresAt: number;
}

/**
 * Offline lexical recall. Jaccard over the normalized token sets of the
 * incoming command and every stored incident. Safe to ship as the default
 * because it can't fail open into expensive behavior and it can't network out.
 */
export class LexicalRecall implements SemanticRecall {
  readonly mode = "lexical" as const;
  readonly #store: IncidentStore;
  readonly #emptyCacheMs: number;
  readonly #now: () => Date;
  #cache: CacheState | undefined;

  constructor(options: LexicalRecallOptions) {
    this.#store = options.store;
    this.#emptyCacheMs = options.emptyCacheMs ?? 1_000;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Short-circuit when the store has no incidents yet. Caches the empty
   * verdict briefly so a hot path that calls recall on every command doesn't
   * pay the COUNT(*) each time.
   */
  #isEmpty(): boolean {
    const now = this.#now().getTime();
    if (this.#cache && this.#cache.emptyExpiresAt > now) return true;
    const empty = this.#store.isEmpty();
    if (empty) this.#cache = { emptyExpiresAt: now + this.#emptyCacheMs };
    return empty;
  }

  invalidateCache(): void {
    this.#cache = undefined;
  }

  recall(request: RecallRequest): RecallHit[] {
    if (this.#isEmpty()) return [];
    if (!request.canonicalCommand.trim()) return [];
    const queryTokens = commandTokens(request.canonicalCommand);
    if (queryTokens.length === 0) return [];
    const limit = request.limit ?? 5;
    const incidents = this.#store.all();
    if (incidents.length === 0) return [];
    const scored: { incident: StoredIncident; similarity: number }[] = [];
    for (const incident of incidents) {
      const candidateTokens = commandTokens(incident.command);
      if (candidateTokens.length === 0) continue;
      const similarity = jaccardSimilarity(queryTokens, candidateTokens);
      if (similarity <= 0) continue;
      scored.push({ incident, similarity });
    }
    scored.sort((left, right) => right.similarity - left.similarity);
    return scored.slice(0, Math.min(limit, maximumCandidates)).map(({ incident, similarity }) => ({
      incidentId: incident.incidentId,
      command: incident.command,
      condition: incident.condition,
      consequence: incident.consequence,
      similarity,
    }));
  }

  record(args: {
    incidentId: string;
    command: string;
    argsContains?: readonly string[];
    argsAnyOf?: readonly string[];
    condition: string;
    consequence: string;
    canonicalCommand: string;
    recordedAt?: string;
  }): void {
    this.#store.record({
      incidentId: args.incidentId,
      command: args.command,
      argsContains: args.argsContains,
      argsAnyOf: args.argsAnyOf,
      condition: args.condition,
      consequence: args.consequence,
      signature: commandSignature(args.canonicalCommand),
      recordedAt: args.recordedAt,
    });
    this.invalidateCache();
  }

  close(): void {
    this.#store.close();
  }
}

export function createLexicalRecall(options: LexicalRecallOptions): LexicalRecall {
  return new LexicalRecall(options);
}