import { expect, test } from "bun:test";
import { backgroundOfferCandidateThreshold, planHybridScan, synchronousSessionLimit } from "../src/ingest/hybrid";
import type { HistoryChunk } from "../src/ingest/types";

function chunk(index: number, content = "failed"): HistoryChunk {
  return {
    source: "codex",
    sessionId: `session-${index}`,
    messageIndex: 0,
    chunkIndex: 0,
    role: "assistant",
    content,
  };
}

test("more than 200 candidates offers background work without opting the user in", () => {
  const candidates = Array.from({ length: backgroundOfferCandidateThreshold + 1 }, (_, index) => chunk(index));
  const plan = planHybridScan(candidates, candidates);

  expect(plan.offerBackground).toBeTrue();
  expect(plan.foreground).toHaveLength(candidates.length);
  expect(plan.background).toHaveLength(0);
});

test("background opt-in keeps the 1500 most recent sessions synchronous", () => {
  const candidates = Array.from({ length: synchronousSessionLimit + 2 }, (_, index) => chunk(index));
  const plan = planHybridScan(candidates, candidates, true);

  expect(plan.foreground).toHaveLength(synchronousSessionLimit);
  expect(plan.background.map((candidate) => candidate.sessionId)).toEqual(["session-0", "session-1"]);
  expect(plan.foreground[0].sessionId).toBe("session-2");
});

test("200 candidates or fewer stays entirely synchronous", () => {
  const candidates = Array.from({ length: backgroundOfferCandidateThreshold }, (_, index) => chunk(index));
  const plan = planHybridScan(candidates, candidates, true);

  expect(plan.offerBackground).toBeFalse();
  expect(plan.foreground).toHaveLength(candidates.length);
  expect(plan.background).toHaveLength(0);
});
