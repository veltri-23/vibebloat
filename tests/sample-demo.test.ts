import { expect, test } from "bun:test";
import { runSampleDemo } from "../src/sample/demo";
import { SAMPLE_LABEL } from "../src/sample/history";

test("the demo runs the whole loop with no model and no history", async () => {
  const result = await runSampleDemo();
  expect(result.steps.map(({ label }) => label)).toEqual(["read", "scrub", "prefilter", "mine", "prove", "allow"]);
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

test("a model that fails at runtime falls back instead of killing the demo", async () => {
  // A stale API key is the common case for someone trying this quickly, and
  // the demo exists precisely so that person still sees the loop.
  const result = await runSampleDemo(async () => { throw new Error("model command failed"); });
  expect(result.mined).toBe("precomputed");
  expect(result.receipts.length).toBeGreaterThanOrEqual(3);
  const mineStep = result.steps.find(({ label }) => label === "mine")!;
  expect(mineStep.detail).toContain("precomputed");
  // It must say the model was tried and failed, not pretend none was set.
  expect(mineStep.detail).toMatch(/model/i);
});

test("the proof runs the real hook entry point an agent would hit", async () => {
  const result = await runSampleDemo();
  // Not a rendered mock: the demo must report the exit code a real agent gets.
  expect(result.blocks.length).toBeGreaterThanOrEqual(3);
  for (const block of result.blocks) {
    expect(block.exitCode).toBe(2);
    expect(block.command).toBeTruthy();
    expect(block.receipt).toContain("BLOCKED");
  }
});

test("the same guard denies a second agent, which is the cross-agent claim", async () => {
  const result = await runSampleDemo();
  const first = result.blocks[0]!;
  expect(first.crossAgent).toBeTruthy();
  // Codex receives a structured deny rather than exit 2.
  const parsed = JSON.parse(first.crossAgent!);
  expect(parsed.hookSpecificOutput.permissionDecision).toBe("deny");
  expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("BLOCKED");
});

test("a safe variant of the same command is not blocked", async () => {
  const result = await runSampleDemo();
  expect(result.allowed.length).toBeGreaterThan(0);
  for (const allowed of result.allowed) {
    expect(allowed.exitCode).toBe(0);
  }
});
