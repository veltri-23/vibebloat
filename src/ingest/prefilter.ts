import type { HistoryChunk } from "./types";

const incidentSignals = /\b(fail(?:ed|ure)?|error|broken|break(?:age|s|ing)?|fix(?:ed)?|retry)\b|\[tool\]/i;

export function prefilterCandidates(chunks: HistoryChunk[]): HistoryChunk[] {
  return chunks.filter((chunk) => incidentSignals.test(chunk.content));
}
