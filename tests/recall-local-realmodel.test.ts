import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { IncidentStore } from "../src/ingest/incidents-store";
import { LocalRecall, setEmbedderForTesting } from "../src/ingest/recall-local";
import { cosineSimilarity, localRecallWarnThreshold } from "../src/ingest/semantic-recall";
import { Runtime } from "../src/runtime";

/**
 * Real-model calibration. One batched sidecar call keeps this useful but cheap.
 * It skips when Node, the optional dependency, or the model is unavailable;
 * VIBEBLOAT_REQUIRE_REALMODEL=1 converts that skip into a hard failure.
 */
const cases = [
  { recorded: "git stash -u", query: "shelve my uncommitted changes" },
  { recorded: "rm -rf node_modules", query: "rm --recursive --force node_modules" },
  { recorded: "git reset --hard HEAD", query: "git reset --hard" },
  { recorded: "git clean -fd", query: "git clean --force --directories" },
] as const;

const localRecallQueries = ["git log --oneline", "git worktree add ../wt"] as const;
const texts = [...new Set([
  ...cases.flatMap(({ recorded, query }) => [recorded, query]),
  ...localRecallQueries,
])];
const workerPath = fileURLToPath(new URL("../src/ingest/embed-worker.mjs", import.meta.url));
const model = "Xenova/all-MiniLM-L6-v2";
const cacheDir = join(process.cwd(), ".vibebloat-model-cache");
const result = spawnSync(process.env.VIBEBLOAT_NODE?.trim() || "node", [
  workerPath,
  "--model", model,
  "--cache-dir", cacheDir,
], {
  input: JSON.stringify({ texts }),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  timeout: 120_000,
});

interface WorkerResponse {
  ok: boolean;
  vectors?: number[][];
  error?: { code: string; message: string };
}

let response: WorkerResponse | undefined;
try {
  response = JSON.parse((result.stdout ?? "").trim().split("\n").at(-1) ?? "") as WorkerResponse;
} catch {
  response = undefined;
}

const unavailableReason = result.error?.message
  ?? (result.status !== 0 ? (result.stderr ?? "").trim() || `worker exited ${result.status}` : undefined)
  ?? (!response?.ok ? response?.error?.message ?? "invalid worker response" : undefined);
const requireRealModel = process.env.VIBEBLOAT_REQUIRE_REALMODEL === "1";

if (unavailableReason && !requireRealModel) {
  test.skip(`real model unavailable — ${unavailableReason} (set VIBEBLOAT_REQUIRE_REALMODEL=1 to hard-fail)`, () => {});
} else {
  test("real MiniLM threshold admits destructive command paraphrases", () => {
    expect(unavailableReason).toBeUndefined();
    const vectors = response?.vectors;
    expect(vectors).toHaveLength(texts.length);
    const byText = new Map(texts.map((text, index) => [text, Float32Array.from(vectors![index] ?? [])]));
    const scores = cases.map((entry) => ({
      ...entry,
      score: cosineSimilarity(byText.get(entry.recorded)!, byText.get(entry.query)!),
    }));

    for (const { recorded, query, score } of scores) {
      expect(score, `${recorded} <> ${query}: ${score.toFixed(4)}`).toBeGreaterThanOrEqual(localRecallWarnThreshold);
    }
  });

  test("real MiniLM returns distinct 384-dimensional vectors", () => {
    expect(unavailableReason).toBeUndefined();
    const vectors = response?.vectors ?? [];
    expect(vectors).toHaveLength(texts.length);
    expect(vectors.every((vector) => vector.length === 384)).toBe(true);
    const fingerprints = new Set(vectors.map((vector) => vector.slice(0, 16).map((value) => value.toFixed(6)).join(",")));
    expect(fingerprints.size).toBeGreaterThan(1);
  });

  test("real MiniLM recall filters benign git commands before warning on a destructive paraphrase", async () => {
    expect(unavailableReason).toBeUndefined();
    const vectors = response?.vectors ?? [];
    const byText = new Map(texts.map((text, index) => [text, Float32Array.from(vectors[index] ?? [])]));
    setEmbedderForTesting((requested) => requested.map((text) => byText.get(text)!));
    const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-realmodel-"));
    const recall = new LocalRecall({ store: new IncidentStore({ path: join(directory, "incidents.sqlite") }) });
    const runtime = new Runtime();
    try {
      await recall.record({
        incidentId: "stash-u",
        command: "git stash -u",
        condition: "121 untracked files left the live tree",
        consequence: "the deploy script was missing its scratch dir",
        canonicalCommand: "git stash -u",
      });

      for (const command of ["git log --oneline", "git worktree add ../wt"]) {
        expect(await runtime.recallAdvisory({ chokepoint: "shell", command }, recall), command).toBeNull();
      }

      const advisory = await runtime.recallAdvisory({ chokepoint: "shell", command: "shelve my uncommitted changes" }, recall);
      expect(advisory?.warning).toContain("git stash -u");
      expect(advisory?.similarity ?? 0).toBeGreaterThanOrEqual(localRecallWarnThreshold);
    } finally {
      setEmbedderForTesting(undefined);
      try { recall.close(); } catch { /* Bun SQLite may retain prepared statements until GC. */ }
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* best-effort test cleanup */ }
    }
  });
}
