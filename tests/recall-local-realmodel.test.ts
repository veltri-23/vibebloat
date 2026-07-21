import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cosineSimilarity, localRecallWarnThreshold } from "../src/ingest/semantic-recall";

/**
 * Real-model calibration. One batched sidecar call keeps this useful but cheap.
 * It skips when Node, the optional dependency, or the model is unavailable;
 * VIBEBLOAT_REQUIRE_REALMODEL=1 converts that skip into a hard failure.
 */
const cases = [
  { recorded: "git stash -u", query: "git stash --include-untracked", warns: true },
  { recorded: "rm -rf node_modules", query: "rm --recursive --force node_modules", warns: true },
  { recorded: "git reset --hard HEAD", query: "git reset --hard", warns: true },
  { recorded: "git clean -fd", query: "git clean --force --directories", warns: true },
  { recorded: "kubectl get pods", query: "kubectl get po", warns: true },
  // Same-tool negatives matter: a threshold that only rejects random commands
  // still floods users whenever command names dominate the embedding.
  { recorded: "git stash -u", query: "git status", warns: false },
  { recorded: "rm -rf node_modules", query: "npm install", warns: false },
  { recorded: "git reset --hard HEAD", query: "git log --oneline", warns: false },
  { recorded: "git clean -fd", query: "git status --short", warns: false },
  { recorded: "kubectl get pods", query: "kubectl delete pod app", warns: false },
] as const;

const texts = [...new Set(cases.flatMap(({ recorded, query }) => [recorded, query]))];
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
  test("real MiniLM threshold separates command paraphrases from same-tool negatives", () => {
    expect(unavailableReason).toBeUndefined();
    const vectors = response?.vectors;
    expect(vectors).toHaveLength(texts.length);
    const byText = new Map(texts.map((text, index) => [text, Float32Array.from(vectors![index] ?? [])]));
    const scores = cases.map((entry) => ({
      ...entry,
      score: cosineSimilarity(byText.get(entry.recorded)!, byText.get(entry.query)!),
    }));

    for (const { recorded, query, warns, score } of scores) {
      expect(score >= localRecallWarnThreshold, `${recorded} <> ${query}: ${score.toFixed(4)}`).toBe(warns);
    }

    const positiveFloor = Math.min(...scores.filter(({ warns }) => warns).map(({ score }) => score));
    const negativeCeiling = Math.max(...scores.filter(({ warns }) => !warns).map(({ score }) => score));
    expect(negativeCeiling).toBeLessThan(localRecallWarnThreshold);
    expect(positiveFloor).toBeGreaterThanOrEqual(localRecallWarnThreshold);
  });

  test("real MiniLM returns distinct 384-dimensional vectors", () => {
    expect(unavailableReason).toBeUndefined();
    const vectors = response?.vectors ?? [];
    expect(vectors).toHaveLength(texts.length);
    expect(vectors.every((vector) => vector.length === 384)).toBe(true);
    const fingerprints = new Set(vectors.map((vector) => vector.slice(0, 16).map((value) => value.toFixed(6)).join(",")));
    expect(fingerprints.size).toBeGreaterThan(1);
  });
}
