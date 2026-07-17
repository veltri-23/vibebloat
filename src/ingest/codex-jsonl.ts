import type { HistoryChunk } from "./types";
import { fallbackSessionId, textContent } from "./types";

export function parseCodexJsonl(input: string, filename: string): HistoryChunk[] {
  const chunks: HistoryChunk[] = [];
  for (const line of input.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as {
      session_id?: unknown;
      sessionId?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown; content?: unknown };
      payload?: { message?: { role?: unknown; content?: unknown }; text?: unknown };
    };
    const message = record.payload?.message ?? record.message;
    const content = textContent(message?.content ?? record.payload?.text);
    if (!content) continue;
    chunks.push({
      source: "codex",
      sessionId: typeof record.session_id === "string" ? record.session_id : typeof record.sessionId === "string" ? record.sessionId : fallbackSessionId(filename),
      messageIndex: chunks.length,
      chunkIndex: 0,
      role: typeof message?.role === "string" ? message.role : "assistant",
      content,
      ...(typeof record.timestamp === "string" ? { timestamp: record.timestamp } : {}),
    });
  }
  return chunks;
}
