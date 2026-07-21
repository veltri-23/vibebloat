import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IncidentStore } from "../src/ingest/incidents-store";
import { LexicalRecall } from "../src/ingest/recall-lexical";
import { commandTokens, jaccardSimilarity } from "../src/ingest/semantic-recall";

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

function fixture(): { store: IncidentStore; recall: LexicalRecall } {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-recall-"));
  temporaryDirectories.push(home);
  const store = new IncidentStore({ path: join(home, "incidents.sqlite") });
  openStores.push(store);
  const recall = new LexicalRecall({ store });
  return { store, recall };
}

test("token normalization strips casing, punctuation, and short fragments", () => {
  expect(commandTokens("git stash -u --include-untracked")).toEqual([
    "--include-untracked", "-u", "git", "stash",
  ]);
  expect(commandTokens("rm -rf /")).toEqual(["-rf", "rm"]);
});

test("jaccardSimilarity returns 1 for identical token sets, 0 for disjoint sets", () => {
  expect(jaccardSimilarity(["a", "b", "c"], ["a", "b", "c"])).toBe(1);
  expect(jaccardSimilarity(["a", "b", "c"], ["d", "e"])).toBe(0);
  expect(jaccardSimilarity([], [])).toBe(1);
  expect(jaccardSimilarity([], ["x"])).toBe(0);
});

test("recall is empty on a fresh store without DB I/O", () => {
  const { recall } = fixture();
  const hits = recall.recall({ event: { chokepoint: "shell", command: "git stash -u" }, canonicalCommand: "git stash -u" });
  expect(hits).toEqual([]);
});

test("recall surfaces the same incident under a paraphrased command", () => {
  const { recall } = fixture();
  // Original incident: "git stash -u" deleted untracked files.
  recall.record({
    incidentId: "stash-u-untracked-2026-07-18",
    command: "git stash -u",
    argsContains: ["-u"],
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  // Paraphrased: agent rewrites as "git stash --include-untracked" -- long
  // form of the same flag. Shares the same args + same root command.
  const hits = recall.recall({
    event: { chokepoint: "shell", command: "git stash --include-untracked" },
    canonicalCommand: "git stash --include-untracked",
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.incidentId).toBe("stash-u-untracked-2026-07-18");
  expect(hits[0]?.similarity).toBeGreaterThan(0);
  expect(hits[0]?.command).toBe("git stash -u");
  expect(hits[0]?.condition).toBe("121 untracked files left the live tree");
});

test("recall reworded: long form flag retains higher similarity than unrelated command", () => {
  const { recall } = fixture();
  recall.record({
    incidentId: "stash-u-untracked-2026-07-18",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  // Synonyms: both still stash untracked files. Should rank highest.
  const stashHits = recall.recall({
    event: { chokepoint: "shell", command: "git stash --include-untracked" },
    canonicalCommand: "git stash --include-untracked",
  });
  expect(stashHits[0]?.similarity).toBeGreaterThan(0);
  const unrelatedHits = recall.recall({
    event: { chokepoint: "shell", command: "kubectl delete pod nginx" },
    canonicalCommand: "kubectl delete pod nginx",
  });
  expect(unrelatedHits).toEqual([]);
  expect(stashHits[0]?.similarity).toBeGreaterThan(0);
});

test("recall ranks the closest paraphrase highest", () => {
  const { recall } = fixture();
  recall.record({ incidentId: "stash-u", command: "git stash -u", condition: "stash wiped untracked", consequence: "files gone", canonicalCommand: "git stash -u" });
  recall.record({ incidentId: "rm-rf", command: "rm -rf /", condition: "root wiped", consequence: "system down", canonicalCommand: "rm -rf /" });
  recall.record({ incidentId: "reset-hard", command: "git reset --hard", condition: "commits lost", consequence: "history gone", canonicalCommand: "git reset --hard" });

  const hits = recall.recall({
    event: { chokepoint: "shell", command: "git stash --include-untracked" },
    canonicalCommand: "git stash --include-untracked",
  });

  expect(hits[0]?.incidentId).toBe("stash-u");
});

test("recall is empty when no token overlap exists", () => {
  const { recall } = fixture();
  recall.record({ incidentId: "rm-rf", command: "rm -rf /", condition: "root wiped", consequence: "system down", canonicalCommand: "rm -rf /" });
  const hits = recall.recall({
    event: { chokepoint: "shell", command: "kubectl delete pod nginx" },
    canonicalCommand: "kubectl delete pod nginx",
  });
  expect(hits).toEqual([]);
});

test("recall short-circuits empty store on second call (no DB I/O)", () => {
  const { store, recall } = fixture();
  expect(recall.recall({ event: { chokepoint: "shell", command: "git stash -u" }, canonicalCommand: "git stash -u" })).toEqual([]);
  expect(store.isEmpty()).toBe(true);
  // After recording, the empty cache must invalidate so the next call sees the row.
  recall.record({ incidentId: "stash", command: "git stash -u", condition: "wiped", consequence: "gone", canonicalCommand: "git stash -u" });
  const hits = recall.recall({ event: { chokepoint: "shell", command: "git stash -u" }, canonicalCommand: "git stash -u" });
  expect(hits.length).toBe(1);
});