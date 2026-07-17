import type { HistoryChunk } from "./types";
import { fallbackSessionId, textContent } from "./types";

export function parseClaudeJsonl(input: string, filename: string): HistoryChunk[] {
  const chunks: HistoryChunk[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { type?: unknown; sessionId?: unknown; timestamp?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } };
    if ((record.type !== "user" && record.type !== "assistant") || record.isMeta === true) continue;
    const content = textContent(record.message?.content);
    if (!content) continue;
    chunks.push({
      source: "claude-code",
      sessionId: typeof record.sessionId === "string" ? record.sessionId : fallbackSessionId(filename),
      messageIndex: chunks.length,
      chunkIndex: 0,
      role: typeof record.message?.role === "string" ? record.message.role : String(record.type),
      content,
      ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    });
  }
  return chunks;
}
