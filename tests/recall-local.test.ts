import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IncidentStore } from "../src/ingest/incidents-store";
import { LocalRecall, setEmbedderForTesting, type Embedder } from "../src/ingest/recall-local";
import { cosineSimilarity } from "../src/ingest/semantic-recall";

const temporaryDirectories: string[] = [];
const openStores: IncidentStore[] = [];

afterEach(() => {
  setEmbedderForTesting(undefined);
  while (openStores.length > 0) {
    const store = openStores.pop();
    try { store?.close(); } catch { /* ignore */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-local-"));
  temporaryDirectories.push(dir);
  return dir;
}

function makeStore(): IncidentStore {
  const store = new IncidentStore({ path: join(tempHome(), "incidents.sqlite") });
  openStores.push(store);
  return store;
}

/**
 * Deterministic 384-dim embedder: a small bag-of-words projection standing in
 * for the neural sidecar. Shared tokens land in the same dimensions, so two
 * phrasings that overlap rank near each other. Exercises `LocalRecall`'s
 * record + recall + cosine k-NN without spawning the real model — the
 * real-model behavior is proven separately in recall-local-realmodel.test.ts.
 */
function makeEmbedder(): Embedder {
  const vocab = new Map<string, number>();
  let counter = 0;
  const dim = (token: string): number => {
    const existing = vocab.get(token);
    if (existing !== undefined) return existing;
    counter += 1;
    vocab.set(token, counter);
    return counter;
  };
  const project = (text: string): Float32Array => {
    const out = new Float32Array(384);
    for (const token of text.toLowerCase().split(/[^a-z0-9_/-]+/).filter((word) => word.length >= 2)) {
      out[dim(token) % 384] += 1;
    }
    let norm = 0;
    for (const value of out) norm += value * value;
    if (norm > 0) {
      const scale = 1 / Math.sqrt(norm);
      for (let index = 0; index < out.length; index += 1) out[index] *= scale;
    }
    return out;
  };
  return (texts) => texts.map(project);
}

function installEmbedder(): void {
  setEmbedderForTesting(makeEmbedder());
}

test("recall degrades to [] when the embedder is unavailable (no model, offline)", async () => {
  const store = makeStore();
  store.record({
    incidentId: "seed",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    signature: "git|stash|u",
  });
  const recall = new LocalRecall({ store });
  setEmbedderForTesting(() => undefined); // worker spawn failed / node missing
  const hits = await recall.recall({ event: { chokepoint: "shell", command: "git stash --keep-index" }, canonicalCommand: "git stash --keep-index" });
  expect(hits).toEqual([]);
  expect(recall.unavailableReason).toBeDefined();
  expect(recall.unavailableAdvisory).toBe(
    "WHAT skipped: local semantic recall is unavailable.\n" +
    "WHY: optional @huggingface/transformers and onnxruntime-node runtime could not load.\n" +
    "FIX: npm install @huggingface/transformers onnxruntime-node",
  );
  // record() also degrades gracefully — losing the embedding beats losing the incident.
  await recall.record({
    incidentId: "unembedded",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  expect(store.findBySignature("git|stash|u")?.embedding).toBeNull();
});

test("missing node degrades promptly without throwing", async () => {
  const store = makeStore();
  store.record({
    incidentId: "seed",
    command: "git stash -u",
    condition: "files disappeared",
    consequence: "restore required",
    signature: "git|stash|u",
  });
  const recall = new LocalRecall({
    store,
    nodeBinary: join(tempHome(), "definitely-missing-node"),
    workerTimeoutMs: 50,
  });
  const startedAt = performance.now();
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "git stash --keep-index" },
    canonicalCommand: "git stash --keep-index",
  });
  expect(hits).toEqual([]);
  expect(recall.unavailableReason).toBeDefined();
  expect(performance.now() - startedAt).toBeLessThan(1_000);
});

test("hung worker is killed at the deadline and recall returns promptly", async () => {
  const directory = tempHome();
  const worker = join(directory, "hung-worker.mjs");
  const pidFile = join(directory, "worker.pid");
  writeFileSync(worker, [
    'import { writeFileSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.stdin.resume();",
    "setInterval(() => {}, 1_000);",
  ].join("\n"));
  const store = makeStore();
  store.record({
    incidentId: "seed",
    command: "git stash -u",
    condition: "files disappeared",
    consequence: "restore required",
    signature: "git|stash|u",
  });
  const recall = new LocalRecall({
    store,
    nodeBinary: process.execPath,
    workerPath: worker,
    workerTimeoutMs: 100,
  });
  let eventLoopProgressed = false;
  setTimeout(() => { eventLoopProgressed = true; }, 0);
  const startedAt = performance.now();
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "git stash --keep-index" },
    canonicalCommand: "git stash --keep-index",
  });
  expect(hits).toEqual([]);
  expect(eventLoopProgressed).toBeTrue();
  expect(performance.now() - startedAt).toBeLessThan(1_000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("recall surfaces a stored incident for a reworded command by meaning (cosine)", async () => {
  installEmbedder();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  await recall.record({
    incidentId: "stash-u",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "git stash --keep-index" },
    canonicalCommand: "git stash --keep-index",
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.incidentId).toBe("stash-u");
  expect(hits[0]?.similarity).toBeGreaterThan(0);
});

test("local cosine ranks a related command above an unrelated distractor", async () => {
  installEmbedder();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  await recall.record({
    incidentId: "stash-u",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  await recall.record({
    incidentId: "rm-rf",
    command: "rm -rf /",
    condition: "root wiped",
    consequence: "system down",
    canonicalCommand: "rm -rf /",
  });
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "git stash --keep-index" },
    canonicalCommand: "git stash --keep-index",
  });
  expect(hits[0]?.incidentId).toBe("stash-u");
});

test("recall ranks the closest paraphrase highest across multiple stored incidents", async () => {
  installEmbedder();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  await recall.record({
    incidentId: "rm-rf",
    command: "rm -rf /",
    condition: "root wiped",
    consequence: "system down",
    canonicalCommand: "rm -rf /",
  });
  await recall.record({
    incidentId: "rename-files",
    command: "rename files with python",
    condition: "silent overwrite of two weeks of work",
    consequence: "restored from backup",
    canonicalCommand: "rename files with python",
  });
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "rename files with shell" },
    canonicalCommand: "rename files with shell",
  });
  expect(hits[0]?.incidentId).toBe("rename-files");
});

test("recall carries its own cosine-calibrated warn threshold, not the lexical default", () => {
  installEmbedder();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  // Cosine matches on short commands land ~0.3; a 0.5 Jaccard threshold would
  // never fire. The backend must advertise its own lower threshold.
  expect(recall.warnThreshold).toBeLessThan(0.5);
  expect(recall.warnThreshold).toBeGreaterThan(0);
});

test("recall with empty store is an empty array (no DB hit beyond the count)", async () => {
  installEmbedder();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  const hits = await recall.recall({ event: { chokepoint: "shell", command: "git stash --keep-index" }, canonicalCommand: "git stash --keep-index" });
  expect(hits).toEqual([]);
  expect(recall.unavailableAdvisory).toBeUndefined();
});

test("mismatched embedding dimensions skip stored rows (defensive against model swap)", async () => {
  installEmbedder();
  const store = makeStore();
  const recall = new LocalRecall({ store, dimensions: 256 });
  const bogus = new Float32Array(384);
  for (let index = 0; index < bogus.length; index += 1) bogus[index] = 1 / bogus.length;
  store.record({
    incidentId: "wrong-dim",
    command: "rm -rf /",
    condition: "root wiped",
    consequence: "system down",
    signature: "rm|-rf|/",
    embedding: bogus,
  });
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "rm -rf /" },
    canonicalCommand: "rm -rf /",
  });
  expect(hits).toEqual([]);
});

test("factory + default config still resolves to lexical (local is opt-in)", async () => {
  installEmbedder();
  const { buildRecall } = await import("../src/ingest/recall-factory");
  const store = makeStore();
  const recall = buildRecall({ store, configPath: undefined, environment: { VIBEBLOAT_HOME: tempHome() } as NodeJS.ProcessEnv });
  expect(recall.mode).toBe("lexical");
  recall.close?.();
});

test("factory routes SR choice of `local` to LocalRecall when config pins it", async () => {
  installEmbedder();
  const { buildRecall } = await import("../src/ingest/recall-factory");
  const { writeRecallConfig } = await import("../src/ingest/recall-config");
  const home = tempHome();
  const configPath = join(home, "config.toml");
  writeRecallConfig(configPath, { mode: "local" });
  const store = makeStore();
  const recall = buildRecall({ store, configPath, environment: { VIBEBLOAT_HOME: home } as NodeJS.ProcessEnv });
  expect(recall.mode).toBe("local");
  recall.close?.();
});

describe("buildSyncRecall (hot path)", () => {
  test("falls back to lexical when the config pins local (sync hot path stays sync)", async () => {
    installEmbedder();
    const { buildSyncRecall } = await import("../src/ingest/recall-factory");
    const { writeRecallConfig } = await import("../src/ingest/recall-config");
    const home = tempHome();
    const configPath = join(home, "config.toml");
    writeRecallConfig(configPath, { mode: "local" });
    const store = makeStore();
    const recall = buildSyncRecall({ store, configPath, environment: { VIBEBLOAT_HOME: home } as NodeJS.ProcessEnv });
    expect(recall.mode).toBe("lexical");
    recall.close?.();
  });
});

test("cosineSimilarity still respects the [0,1] contract for the local backend", () => {
  const a = new Float32Array([1, 0, 0]);
  const b = new Float32Array([0, 1, 0]);
  expect(cosineSimilarity(a, b)).toBe(0);
  expect(cosineSimilarity(a, a)).toBe(1);
});
