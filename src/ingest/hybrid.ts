import type { HistoryChunk } from "./types";

export const synchronousSessionLimit = 1_500;
export const backgroundOfferCandidateThreshold = 200;

export interface HybridScanPlan {
  offerBackground: boolean;
  foreground: HistoryChunk[];
  background: HistoryChunk[];
  totalSessions: number;
  foregroundSessions: number;
}

function sessionKey(chunk: HistoryChunk): string {
  return `${chunk.source}:${chunk.sessionId}`;
}

function recentSessionKeys(chunks: readonly HistoryChunk[]): Set<string> {
  const lastSeen = new Map<string, number>();
  for (const [index, chunk] of chunks.entries()) lastSeen.set(sessionKey(chunk), index);
  return new Set([...lastSeen.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, synchronousSessionLimit)
    .map(([key]) => key));
}

export function planHybridScan(
  chunks: readonly HistoryChunk[],
  candidates: readonly HistoryChunk[],
  backgroundOptIn = false,
): HybridScanPlan {
  const totalSessions = new Set(chunks.map(sessionKey)).size;
  const offerBackground = candidates.length > backgroundOfferCandidateThreshold;
  if (!offerBackground || !backgroundOptIn || totalSessions <= synchronousSessionLimit) {
    return {
      offerBackground,
      foreground: [...candidates],
      background: [],
      totalSessions,
      foregroundSessions: totalSessions,
    };
  }

  const foregroundKeys = recentSessionKeys(chunks);
  return {
    offerBackground,
    foreground: candidates.filter((candidate) => foregroundKeys.has(sessionKey(candidate))),
    background: candidates.filter((candidate) => !foregroundKeys.has(sessionKey(candidate))),
    totalSessions,
    foregroundSessions: foregroundKeys.size,
  };
}
