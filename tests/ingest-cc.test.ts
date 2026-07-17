import { expect, test } from "bun:test";
import { parseClaudeJsonl } from "../src/ingest/cc-jsonl";

test("Claude adapter keeps user, assistant, and tool chunks with ordinal evidence keys", () => {
  const chunks = parseClaudeJsonl([
    JSON.stringify({ type: "user", sessionId: "session-1", timestamp: "2026-07-17T00:00:00Z", message: { content: "run git stash -u" } }),
    JSON.stringify({ type: "assistant", sessionId: "session-1", message: { content: "[tool] git stash -u" } }),
    JSON.stringify({ type: "assistant", isMeta: true, message: { content: "ignore" } }),
  ].join("\n"), "fallback.jsonl");

  expect(chunks).toEqual([
    { source: "claude-code", sessionId: "session-1", messageIndex: 0, chunkIndex: 0, role: "user", content: "run git stash -u", timestamp: "2026-07-17T00:00:00Z" },
    { source: "claude-code", sessionId: "session-1", messageIndex: 1, chunkIndex: 0, role: "assistant", content: "[tool] git stash -u" },
  ]);
});
