import { expect, test } from "bun:test";
import { parseCodexJsonl } from "../src/ingest/codex-jsonl";

test("Codex adapter reads nested response messages with stable ordinals", () => {
  const chunks = parseCodexJsonl(JSON.stringify({
    session_id: "codex-1",
    timestamp: "2026-07-17T00:00:00Z",
    payload: { message: { role: "assistant", content: "git stash -u failed" } },
  }), "fallback.jsonl");

  expect(chunks).toEqual([
    { source: "codex", sessionId: "codex-1", messageIndex: 0, chunkIndex: 0, role: "assistant", content: "git stash -u failed", timestamp: "2026-07-17T00:00:00Z" },
  ]);
});
