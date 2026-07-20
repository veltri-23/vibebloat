import { expect, test } from "bun:test";
import { sampleHistory, samplePrecomputedIncidents, SAMPLE_LABEL } from "../src/sample/history";
import { prefilterCandidates } from "../src/ingest/prefilter";
import { builtinRedact } from "../src/scrub/builtin";
import { compileGuard } from "../src/compiler/codex-fill";
import { match } from "../src/match";
import { syntheticEvent } from "../src/compiler/synthetic-event";

test("the sample is labelled as a sample everywhere it can be seen", () => {
  expect(SAMPLE_LABEL).toMatch(/sample/i);
  for (const chunk of sampleHistory()) {
    expect(chunk.sessionId).toContain("sample");
  }
});

test("the sample carries no real credentials or personal paths", () => {
  for (const chunk of sampleHistory()) {
    const { findings } = builtinRedact(chunk.content);
    const leaked = findings.filter(({ name }) => name !== "absolute_path_unix" && name !== "absolute_path");
    expect(leaked).toEqual([]);
  }
});

test("the sample survives the real prefilter, or the demo mines nothing", () => {
  const kept = prefilterCandidates(sampleHistory());
  // Every planted incident must carry a signal the real gate recognizes.
  expect(kept.length).toBeGreaterThanOrEqual(3);
});

test("precomputed findings reference sessions that exist in the sample", () => {
  const sessions = new Set(sampleHistory().map(({ sessionId }) => sessionId));
  for (const incident of samplePrecomputedIncidents()) {
    for (const reference of incident.evidence_refs) {
      expect(sessions.has(reference.split(":")[0]!)).toBe(true);
    }
  }
});

test("every precomputed finding compiles to a guard that fires", () => {
  for (const incident of samplePrecomputedIncidents()) {
    const guard = compileGuard(incident, incident.severity >= 4 ? "high" : "low");
    expect(match(guard, syntheticEvent(guard)).fired).toBe(true);
  }
});

test("the flagship sample guard blocks the destructive form only", () => {
  const incident = samplePrecomputedIncidents().find(({ command }) => command === "git stash")!;
  const guard = compileGuard(incident, "high");
  expect(match(guard, { chokepoint: "shell", command: "git stash -u" }).fired).toBe(true);
  expect(match(guard, { chokepoint: "shell", command: "git stash" }).fired).toBe(false);
});

test("findings carry the remediation that makes a receipt useful", () => {
  for (const incident of samplePrecomputedIncidents()) {
    expect(incident.remediation).toBeTruthy();
    expect(incident.condition.length).toBeGreaterThan(10);
  }
});
