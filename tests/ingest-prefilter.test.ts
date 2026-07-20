import { expect, test } from "bun:test";
import { prefilterCandidates } from "../src/ingest/prefilter";
import type { HistoryChunk } from "../src/ingest/types";

test("prefilter keeps failure, correction, and repeated tool-call signals", () => {
  const candidates = prefilterCandidates([
    { source: "claude-code", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "assistant", content: "everything fine" },
    { source: "claude-code", sessionId: "one", messageIndex: 1, chunkIndex: 0, role: "assistant", content: "[tool] git stash -u failed" },
    { source: "codex", sessionId: "two", messageIndex: 0, chunkIndex: 0, role: "user", content: "fix the broken config" },
  ]);

  expect(candidates.map((candidate) => candidate.content)).toEqual(["[tool] git stash -u failed", "fix the broken config"]);
});

function chunk(content: string): HistoryChunk {
  return { source: "claude-code", sessionId: "s", messageIndex: 0, chunkIndex: 0, role: "user", content };
}

function keeps(content: string): boolean {
  return prefilterCandidates([chunk(content)]).length === 1;
}

// Real frustration samples measured on Hunter's machine (PROJECT-SEED.md section 3).
// Frustration is the labeled training data the product exists to mine; if the
// prefilter drops these, the model never sees the incidents that matter.
test("keeps real frustration markers from the measured corpus", () => {
  const samples = [
    "Oh my fucking AI Slop, revert back to the old website",
    "Basically hermes is supposed to handle it wtf u mean",
    "Get rid of open-claw shit",
    "omfg you ran git stash -u and deleted my untracked launcher scripts",
    "that git stash -u wiped the files again, stop doing that",
    "why did you overwrite my config??",
    "NO. I said do not touch the database",
    "you just nuked my uncommitted work",
  ];
  for (const sample of samples) expect(keeps(sample)).toBe(true);
});

// The seed documents this exact false positive from the naive regex pass.
test("drops benign messages that merely resemble frustration", () => {
  const benign = [
    "stop when u can and save progress",
    "can you break this into smaller functions",
    "thanks, that worked perfectly",
    "run the tests and show me the output",
    "add a retry helper to the client later",
  ];
  for (const sample of benign) expect(keeps(sample)).toBe(false);
});
