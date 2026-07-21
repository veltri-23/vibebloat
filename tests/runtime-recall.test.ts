import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IncidentStore } from "../src/ingest/incidents-store";
import { LexicalRecall } from "../src/ingest/recall-lexical";
import { OffRecall } from "../src/ingest/recall-factory";
import { Runtime } from "../src/runtime";
import { localRecallWarnThreshold, type RecallHit, type SemanticRecall, type SyncSemanticRecall } from "../src/ingest/semantic-recall";
import type { Event, Guard } from "../src/types";

const temporaryDirectories: string[] = [];
const openStores: IncidentStore[] = [];
afterEach(() => {
  while (openStores.length > 0) {
    const store = openStores.pop();
    try { store?.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function lexicalFixture(): { runtime: Runtime; recall: LexicalRecall } {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-runtime-recall-"));
  temporaryDirectories.push(home);
  const store = new IncidentStore({ path: join(home, "incidents.sqlite") });
  openStores.push(store);
  const recall = new LexicalRecall({ store });
  return { runtime: new Runtime([], undefined, undefined, undefined, recall), recall };
}

function warnGuard(): Guard {
  return {
    id: "warn-blocklist",
    class: "A",
    provenance: { incident: "demo", date: "2026-07-20", source: "test" },
    match: { chokepoint: "shell", command: "rm", argsAnyOf: ["-rf", "/"] },
    action: { type: "warn", message: "danger", override: "vibebloat allow warn-blocklist --once" },
    enabled: true,
  };
}

function recallHit(similarity: number): RecallHit {
  return {
    incidentId: "calibration-hit",
    command: "git stash -u",
    condition: "untracked files disappeared",
    consequence: "manual recovery was required",
    similarity,
  };
}

function fakeSyncRecall(similarity: number, warnThreshold?: number): SyncSemanticRecall {
  return {
    mode: "lexical",
    ...(warnThreshold === undefined ? {} : { warnThreshold }),
    recall: () => [recallHit(similarity)],
    record: () => {},
  };
}

function fakeAsyncRecall(similarity: number, warnThreshold?: number): SemanticRecall {
  return {
    mode: "local",
    ...(warnThreshold === undefined ? {} : { warnThreshold }),
    recall: async () => [recallHit(similarity)],
    record: async () => {},
  };
}

test("zero-cost: runtime without recall behaves exactly like the legacy loop", () => {
  const runtime = new Runtime();
  const verdict = runtime.evaluate([], { chokepoint: "shell", command: "git stash -u" });
  expect(verdict).toEqual({ fired: false });
});

test("sync recall failure cannot block the enforcement allow path", () => {
  const recall: SyncSemanticRecall = {
    mode: "lexical",
    recall: () => { throw new Error("recall unavailable"); },
    record: () => {},
  };
  const runtime = new Runtime([], undefined, undefined, undefined, recall);
  expect(runtime.evaluate([], { chokepoint: "shell", command: "echo safe" })).toEqual({ fired: false });
});

test("off recall adapter is a true no-op on the hot path", () => {
  const runtime = new Runtime([], undefined, undefined, undefined, new OffRecall());
  const verdict = runtime.evaluate([], { chokepoint: "shell", command: "git stash -u" });
  expect(verdict).toEqual({ fired: false });
});

test("lexical recall adds a warning when a similar past incident exists", () => {
  const { runtime, recall } = lexicalFixture();
  recall.record({
    incidentId: "stash-u-untracked",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  const verdict = runtime.evaluate([], {
    chokepoint: "shell",
    command: "git stash --include-untracked",
    cwd: "D:/AI/orca/workspaces/scratch",
  });
  expect(verdict.fired).toBe(false);
  expect(verdict.warning).toContain("git stash -u");
  expect(verdict.warning).toContain("121 untracked files left the live tree");
});

test("recall never blocks — a guard firing still wins", () => {
  const { runtime, recall } = lexicalFixture();
  recall.record({
    incidentId: "rm-rf",
    command: "rm -rf /",
    condition: "root wiped",
    consequence: "system down",
    canonicalCommand: "rm -rf /",
  });
  const verdict = runtime.evaluate([warnGuard()], { chokepoint: "shell", command: "rm -rf /" });
  expect(verdict.fired).toBe(true);
  // The guard's own warn message wins; recall does not override it.
  expect(verdict.warning).toBe("danger");
  expect(verdict.warning).not.toContain("root wiped");
});

test("recall returns fired=false and no warning when no incident matches", () => {
  const { runtime } = lexicalFixture();
  const verdict = runtime.evaluate([], { chokepoint: "shell", command: "kubectl delete pod nginx" });
  expect(verdict).toEqual({ fired: false });
});

test("recall ignores empty canonical commands", () => {
  const { runtime, recall } = lexicalFixture();
  recall.record({ incidentId: "x", command: "git stash -u", condition: "c", consequence: "k", canonicalCommand: "git stash -u" });
  const verdict = runtime.evaluate([], { chokepoint: "shell" });
  expect(verdict).toEqual({ fired: false });
});

test("async recallAdvisory surfaces a structured advisory for async backends", async () => {
  const { runtime, recall } = lexicalFixture();
  recall.record({ incidentId: "stash-u", command: "git stash -u", condition: "lost work", consequence: "manual restore", canonicalCommand: "git stash -u" });
  const advisory = await runtime.recallAdvisory({ chokepoint: "shell", command: "git stash --include-untracked" });
  expect(advisory).not.toBeNull();
  expect(advisory?.incidentId).toBe("stash-u");
  expect(advisory?.warning).toContain("lost work");
});

const thresholdCases = [
  { name: "below backend threshold", similarity: localRecallWarnThreshold - 0.01, threshold: localRecallWarnThreshold, warns: false },
  { name: "at backend threshold", similarity: localRecallWarnThreshold, threshold: localRecallWarnThreshold, warns: true },
  { name: "below default fallback", similarity: 0.49, threshold: undefined, warns: false },
  { name: "at default fallback", similarity: 0.5, threshold: undefined, warns: true },
] as const;

test("sync runtime applies backend-specific threshold with default fallback", () => {
  for (const { name, similarity, threshold, warns } of thresholdCases) {
    const runtime = new Runtime([], undefined, undefined, undefined, fakeSyncRecall(similarity, threshold));
    const verdict = runtime.evaluate([], { chokepoint: "shell", command: "git stash --include-untracked" });
    expect(Boolean(verdict.warning), name).toBe(warns);
  }
});

test("async runtime applies adapter-specific threshold with default fallback", async () => {
  const runtime = new Runtime();
  for (const { name, similarity, threshold, warns } of thresholdCases) {
    const advisory = await runtime.recallAdvisory(
      { chokepoint: "shell", command: "git stash --include-untracked" },
      fakeAsyncRecall(similarity, threshold),
    );
    expect(advisory !== null, name).toBe(warns);
  }
});

test("recall hot path short-circuits when no command is present", () => {
  const { runtime, recall } = lexicalFixture();
  recall.record({ incidentId: "x", command: "git stash -u", condition: "c", consequence: "k", canonicalCommand: "git stash -u" });
  const event: Event = { chokepoint: "shell" };
  expect(runtime.evaluate([], event)).toEqual({ fired: false });
});
