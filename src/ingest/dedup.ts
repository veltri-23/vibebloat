import type { HistoryChunk } from "./types";

export interface DedupedCandidate extends HistoryChunk {
  fingerprint: string;
  frequency: number;
  evidenceRefs: string[];
}

export function candidateFingerprint(content: string): string {
  return content.trim().replace(/\s+/g, " ").toLowerCase();
}

export function dedupeCandidates(candidates: HistoryChunk[]): DedupedCandidate[] {
  const deduped = new Map<string, DedupedCandidate>();
  for (const candidate of candidates) {
    const key = candidateFingerprint(candidate.content);
    const current = deduped.get(key) ?? { ...candidate, fingerprint: key, frequency: 0, evidenceRefs: [] };
    current.evidenceRefs.push(`${candidate.source}:${candidate.sessionId}:${candidate.messageIndex}:${candidate.chunkIndex}`);
    deduped.set(key, current);
  }
  // Frequency must report distinct message occurrences, not the number of
  // times the prefilter happened to re-read the same chunk. Dedup refs by
  // (source, sessionId, messageIndex) and set frequency from the unique
  // count. A user-facing claim of "you made this mistake 5 times" should
  // match 5 distinct messages, not 5 chunks from the same message.
  for (const candidate of deduped.values()) {
    const unique = new Set(candidate.evidenceRefs.map((ref) => ref.split(":").slice(0, 3).join(":")));
    candidate.evidenceRefs = [...unique];
    candidate.frequency = unique.size;
  }
  return [...deduped.values()].sort((left, right) => right.frequency - left.frequency || left.fingerprint.localeCompare(right.fingerprint));
}
