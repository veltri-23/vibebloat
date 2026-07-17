export type HistorySource = "claude-code" | "codex" | "hermes";

export interface HistoryChunk {
  source: HistorySource;
  sessionId: string;
  messageIndex: number;
  chunkIndex: number;
  role: string;
  content: string;
  timestamp?: string;
}

export function fallbackSessionId(filename: string): string {
  return filename.replace(/^.*[\\/]/, "").replace(/\.jsonl?$/, "");
}

export function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const chunks = value
    .map((item) => typeof item === "string" ? item : typeof item === "object" && item !== null && "text" in item && typeof item.text === "string" ? item.text : undefined)
    .filter((item): item is string => item !== undefined);
  return chunks.length ? chunks.join("\n") : undefined;
}
