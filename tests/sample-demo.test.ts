import { expect, test } from "bun:test";
import { runSampleDemo } from "../src/sample/demo";
import { SAMPLE_LABEL } from "../src/sample/history";

test("the demo runs the whole loop with no model and no history", async () => {
  const result = await runSampleDemo();
  expect(result.steps.map(({ label }) => label)).toEqual(["read", "scrub", "prefilter", "mine", "prove"]);
  expect(result.receipts.length).toBeGreaterThanOrEqual(3);
  expect(result.receipts[0]).toContain("BLOCKED");
});

test("it says plainly that offline findings are precomputed", async () => {
  const result = await runSampleDemo();
  expect(result.mined).toBe("precomputed");
  const mineStep = result.steps.find(({ label }) => label === "mine")!;
  expect(mineStep.detail).toContain("precomputed");
});

test("it labels the corpus as sample data", async () => {
  const result = await runSampleDemo();
  expect(result.steps[0]!.detail).toContain(SAMPLE_LABEL);
});

test("a configured model does the mining for real", async () => {
  let sawCandidates = 0;
  const result = await runSampleDemo(async (candidates) => {
    sawCandidates = candidates.length;
    return [{
      incident_id: "mined-live", class: "A", chokepoint: "shell", command: "git stash",
      args_contains: ["-u"], condition: "mined during the demo", remediation: "Scope it.",
      evidence_refs: ["sample-session-1:0"], severity: 5, frequency: 2, recency: "2026-07-15",
    }];
  });
  expect(sawCandidates).toBeGreaterThan(0);
  expect(result.mined).toBe("model");
  expect(result.incidents[0]!.incident_id).toBe("mined-live");
  expect(result.steps.find(({ label }) => label === "mine")!.detail).not.toContain("precomputed");
});

test("the miner only ever sees scrubbed, prefiltered content", async () => {
  await runSampleDemo(async (candidates) => {
    for (const candidate of candidates) {
      expect(candidate.content).not.toMatch(/Bearer\s+(?!<redacted>)\S+/);
    }
    return [];
  });
});
