import type { Event } from "../types";

/**
 * The mode knob. `lexical` ships as the safe default: zero new dependencies,
 * works offline, catches reworded-same-command. `embed` and `local` opt in to
 * higher-quality (and more expensive) recall. `off` removes the subsystem
 * from the hot path entirely.
 */
export type RecallMode = "lexical" | "embed" | "local" | "off";

/**
 * What the warn narration shows. The user-facing copy is built from these so
 * the stored incident does the talking — no fabricated prose.
 */
export interface RecallHit {
  incidentId: string;
  /** Stored command text. Used verbatim in narration. */
  command: string;
  /** Why the past command went wrong. Verbatim from the stored incident. */
  condition: string;
  /** What the user had to do about it. Verbatim from the stored incident. */
  consequence: string;
  /** Similarity in [0, 1]. Backends compute it on their own scale. */
  similarity: number;
}

export interface RecallRequest {
  event: Event;
  /** Pre-normalized command text (e.g. via matcher's git-alias/flag strip). */
  canonicalCommand: string;
  limit?: number;
  /** Abort the search early when downstream work is cancelled. */
  signal?: AbortSignal;
}

export interface SemanticRecall {
  readonly mode: RecallMode;
  /** User-facing recovery hint, populated only after an optional backend fails. */
  readonly unavailableAdvisory?: string;
  /**
   * Backend-specific warn threshold on this backend's own similarity scale.
   * Lexical Jaccard and neural cosine are NOT the same scale — a shared global
   * threshold over-fires one to satisfy the other. Runtime prefers this when
   * set, falling back to `recallWarnThreshold`.
   */
  readonly warnThreshold?: number;
  /** Return similar past incidents. Empty array = no recall match. */
  recall(request: RecallRequest): Promise<RecallHit[]> | RecallHit[];
  /** Persist a new incident so future commands can recall it. */
  record(args: {
    incidentId: string;
    command: string;
    argsContains?: readonly string[];
    argsAnyOf?: readonly string[];
    condition: string;
    consequence: string;
    canonicalCommand: string;
    recordedAt?: string;
  }): Promise<void> | void;
  /** Free adapter-owned resources. */
  close?(): void;
}

/**
 * Sync-only subset. The enforcement hot path is synchronous; backends that
 * need network I/O expose a separate async adapter and callers compose them
 * via `recallAdvisory` rather than via `evaluate`. Lexical + Off satisfy this.
 */
export interface SyncSemanticRecall extends SemanticRecall {
  recall(request: RecallRequest): RecallHit[];
}

/** Default warning threshold for lexical Jaccard backends. */
export const recallWarnThreshold = 0.5;

/**
 * all-MiniLM-L6-v2 cosine threshold, calibrated against equivalent command
 * spellings and realistic same-tool negatives. The pinned model scores the
 * accepted paraphrases at 0.702-0.889 and negatives at or below 0.674; 0.69
 * sits between those observed sets. Retune with the real-model matrix when the
 * model changes.
 * ponytail: calibration knob, not a magic number — re-measure on model swap.
 */
export const localRecallWarnThreshold = 0.69;

/**
 * Stable token set from a normalized command. Reused across record() and
 * recall() so two phrasings of the same mistake produce identical signatures.
 */
export function commandTokens(command: string): string[] {
  const tokens = new Set<string>();
  for (const word of command.toLowerCase().split(/[^a-z0-9_/-]+/)) {
    if (word.length >= 2) tokens.add(word);
  }
  return [...tokens].sort();
}

export function commandSignature(canonicalCommand: string): string {
  return commandTokens(canonicalCommand).join("|");
}

/**
 * Jaccard over the token sets. 1.0 = identical; 0 = nothing in common.
 * Stable across paraphrases that share the same args.
 */
export function jaccardSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) if (rightSet.has(token)) intersection += 1;
  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cosine over Float32 vectors. Either side empty / mismatched dim = 0.
 * Used by the `embed` backend on its own stored Float32 blobs.
 */
export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Narration for the warn verdict. Same shape across all backends — the
 * difference is what surfaces, not how it's described.
 */
export function narrateRecallHit(hit: RecallHit, workingDir?: string): string {
  const scope = workingDir ? ` in ${workingDir}` : "";
  return `Looks like the \`${hit.command}\` mistake you hit before${scope} — last time: ${hit.condition}, ${hit.consequence}.`;
}

/**
 * Backend registry — keeps the loader table-shaped so adding a backend means
 * one entry and one test, not a chain of if/else at every call site.
 */
export interface RecallBackend {
  readonly id: RecallMode;
  readonly available: boolean;
  readonly reason?: string;
  create(): SemanticRecall | Promise<SemanticRecall>;
}

/** Pick the first available backend that matches the requested mode. */
export function selectRecallBackend(mode: RecallMode, backends: readonly RecallBackend[]): RecallBackend | undefined {
  for (const backend of backends) {
    if (backend.id === mode && backend.available) return backend;
  }
  return undefined;
}
