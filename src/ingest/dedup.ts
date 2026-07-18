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
    current.frequency += 1;
    current.evidenceRefs.push(`${candidate.source}:${candidate.sessionId}:${candidate.messageIndex}:${candidate.chunkIndex}`);
    deduped.set(key, current);
  }
  return [...deduped.values()].sort((left, right) => right.frequency - left.frequency || left.fingerprint.localeCompare(right.fingerprint));
}
