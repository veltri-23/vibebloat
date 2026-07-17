import type { HistoryChunk } from "./types";
import { fallbackSessionId, textContent } from "./types";

export function parseHermesHistory(input: string, filename: string): HistoryChunk[] {
  const record = JSON.parse(input) as {
    session_id?: unknown;
    request?: { body?: { messages?: Array<{ role?: unknown; content?: unknown }> } };
  };
  const sessionId = typeof record.session_id === "string" ? record.session_id : fallbackSessionId(filename);
  return (record.request?.body?.messages ?? []).flatMap((message, messageIndex) => {
    const content = textContent(message.content);
    return content ? [{
      source: "hermes" as const,
      sessionId,
      messageIndex,
      chunkIndex: 0,
      role: typeof message.role === "string" ? message.role : "unknown",
      content,
    }] : [];
  });
}
