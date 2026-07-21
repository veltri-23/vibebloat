import type { IncidentStore } from "./incidents-store";
import {
  type RecallHit,
  type RecallRequest,
  type SemanticRecall,
} from "./semantic-recall";

/**
 * Stub adapter for the `local` backend. The pluggable surface ships now so a
 * real ONNX / bge-small embedder can bolt on without changing the hot path
 * or the onboarding flow. Anyone selecting `local` today gets a clear
 * "not implemented yet" signal rather than silent fallback to lexical.
 */
export interface LocalRecallOptions {
  store: IncidentStore;
}

export class LocalRecall implements SemanticRecall {
  readonly mode = "local" as const;
  readonly #store: IncidentStore;
  #recorded = 0;

  constructor(options: LocalRecallOptions) {
    this.#store = options.store;
  }

  recall(_request: RecallRequest): RecallHit[] {
    // Ponytail: a stub that no-ops with a clear signal beats a silent fallback
    // that the user mistakes for working semantics. The recorder still accepts
    // incidents so installing the local backend later doesn't lose data.
    return [];
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
      signature: args.canonicalCommand,
      recordedAt: args.recordedAt,
    });
    this.#recorded += 1;
  }

  /** Test-only signal: how many incidents have landed since boot. */
  get recordedCount(): number {
    return this.#recorded;
  }

  close(): void {
    this.#store.close();
  }
}

export function createLocalRecall(options: LocalRecallOptions): LocalRecall {
  return new LocalRecall(options);
}