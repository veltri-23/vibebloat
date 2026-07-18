import type { HistoryChunk } from "../ingest/types";

const scrubbed = Symbol("scrubbed-candidates");

export interface ScrubbedCandidates {
  readonly candidates: HistoryChunk[];
  readonly [scrubbed]: true;
}

export function markScrubbedCandidates(candidates: HistoryChunk[]): ScrubbedCandidates {
  return { candidates, [scrubbed]: true };
}

export function isScrubbedCandidates(value: unknown): value is ScrubbedCandidates {
  return Boolean(value && typeof value === "object" && (value as ScrubbedCandidates)[scrubbed] === true);
}
