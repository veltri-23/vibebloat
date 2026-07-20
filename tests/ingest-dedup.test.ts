import { expect, test } from "bun:test";
import { dedupeCandidates } from "../src/ingest/dedup";

test("dedup merges repeated evidence across agents and raises frequency", () => {
  const incidents = dedupeCandidates([
    { source: "claude-code", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "assistant", content: "git stash -u failed" },
    { source: "codex", sessionId: "two", messageIndex: 3, chunkIndex: 0, role: "assistant", content: "git stash -u failed" },
  ]);

  expect(incidents).toEqual([{
    source: "claude-code",
    sessionId: "one",
    messageIndex: 0,
    chunkIndex: 0,
    role: "assistant",
    content: "git stash -u failed",
    fingerprint: "git stash -u failed",
    frequency: 2,
    evidenceRefs: ["claude-code:one:0", "codex:two:3"],
  }]);
});
