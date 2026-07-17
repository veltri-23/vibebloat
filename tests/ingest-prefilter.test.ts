import { expect, test } from "bun:test";
import { prefilterCandidates } from "../src/ingest/prefilter";

test("prefilter keeps failure, correction, and repeated tool-call signals", () => {
  const candidates = prefilterCandidates([
    { source: "claude-code", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "assistant", content: "everything fine" },
    { source: "claude-code", sessionId: "one", messageIndex: 1, chunkIndex: 0, role: "assistant", content: "[tool] git stash -u failed" },
    { source: "codex", sessionId: "two", messageIndex: 0, chunkIndex: 0, role: "user", content: "fix the broken config" },
  ]);

  expect(candidates.map((candidate) => candidate.content)).toEqual(["[tool] git stash -u failed", "fix the broken config"]);
});
