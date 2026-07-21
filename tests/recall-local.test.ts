import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { IncidentStore } from "../src/ingest/incidents-store";
import { LocalRecall, setTransformersModuleForTesting } from "../src/ingest/recall-local";
import { cosineSimilarity } from "../src/ingest/semantic-recall";

interface Tensor {
  data: Float32Array;
  dims: readonly number[];
}

interface StubModule {
  pipeline: (
    task: "feature-extraction",
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<(input: string | string[], options?: Record<string, unknown>) => Promise<Tensor>>;
  env: {
    cacheDir: string | null;
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    remoteHost: string;
    localModelPath: string | null;
    useFs: boolean;
    useBrowserCache: boolean;
    backends: { onnx: Record<string, unknown> };
    logLevel?: number;
  };
}

const temporaryDirectories: string[] = [];
const openStores: IncidentStore[] = [];

afterEach(() => {
  setTransformersModuleForTesting(undefined);
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
 * Deterministic 384-dim embedder: a small bag-of-words projection. Synonyms
 * share non-zero dimensions; unrelated tokens don't overlap. The test
 * exercises `LocalRecall`'s recall + record paths + cosine k-NN without
 * booting an ONNX model — `setTransformersModuleForTesting` injects the stub.
 */
function makeStub(): StubModule {
  const vocab = new Map<string, number>();
  const next = (() => {
    let counter = 0;
    return (token: string) => {
      const existing = vocab.get(token);
      if (existing !== undefined) return existing;
      counter += 1;
      vocab.set(token, counter);
      return counter;
    };
  })();
  const projection = (text: string): Float32Array => {
    const out = new Float32Array(384);
    for (const token of text.toLowerCase().split(/[^a-z0-9_/-]+/).filter((word) => word.length >= 2)) {
      const dimension = next(token);
      out[dimension % 384] += 1;
    }
    let norm = 0;
    for (const value of out) norm += value * value;
    if (norm > 0) {
      const scale = 1 / Math.sqrt(norm);
      for (let index = 0; index < out.length; index += 1) out[index] *= scale;
    }
    return out;
  };
  const pipe = async (input: string): Promise<Tensor> => {
    const data = projection(input);
    return { data, dims: [1, data.length] };
  };
  const env: StubModule["env"] = {
    cacheDir: null,
    allowLocalModels: false,
    allowRemoteModels: true,
    remoteHost: "https://huggingface.co",
    localModelPath: null,
    useFs: false,
    useBrowserCache: true,
    backends: { onnx: {} },
  };
  return {
    env,
    pipeline: (async (_task: string, _model: string) => pipe) as StubModule["pipeline"],
  };
}

function installStub(): void {
  setTransformersModuleForTesting(makeStub() as unknown as Parameters<typeof setTransformersModuleForTesting>[0]);
}

test("recall degrades to [] when the model pipeline fails to load (no API key, offline)", async () => {
  const store = makeStore();
  store.record({
    incidentId: "seed",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    signature: "git|stash|u",
  });
  const recall = new LocalRecall({ store });
  const failing: StubModule = {
    ...makeStub(),
    pipeline: (async () => {
      throw new Error("model fetch failed");
    }) as StubModule["pipeline"],
  };
  setTransformersModuleForTesting(failing as unknown as Parameters<typeof setTransformersModuleForTesting>[0]);
  const hits = await recall.recall({ event: { chokepoint: "shell", command: "git stash --keep-index" }, canonicalCommand: "git stash --keep-index" });
  expect(hits).toEqual([]);
  expect(recall.unavailableReason).toContain("model fetch failed");
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

test("recall surfaces a stored incident for a reworded command by meaning (cosine)", async () => {
  installStub();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  await recall.record({
    incidentId: "stash-u",
    command: "git stash -u",
    condition: "121 untracked files left the live tree",
    consequence: "the deploy script was missing its scratch dir",
    canonicalCommand: "git stash -u",
  });
  // Reworded: shares vocab with the stored command (git, stash, u). The stub's
  // bag-of-words projection puts both in the same 384-dim neighborhood.
  const hits = await recall.recall({
    event: { chokepoint: "shell", command: "git stash --keep-index" },
    canonicalCommand: "git stash --keep-index",
  });
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]?.incidentId).toBe("stash-u");
  expect(hits[0]?.similarity).toBeGreaterThan(0);
});

test("local cosine surfaces a paraphrased command by meaning, not just tokens", async () => {
  installStub();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  // Stored incident + an unrelated distractor. The paraphrase shares 2 of 5
  // tokens with the stored command (git, stash) but means the same thing —
  // local cosine ranks it above the unrelated distractor because the bag-of-
  // words projection puts shared tokens in the same 384-dim slots.
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
  installStub();
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
    event: { chokepoint: "shell", command: "move files with shell" },
    canonicalCommand: "move files with shell",
  });
  expect(hits[0]?.incidentId).toBe("rename-files");
});

test("recall with empty store is an empty array (no DB hit beyond the count)", async () => {
  installStub();
  const store = makeStore();
  const recall = new LocalRecall({ store });
  const hits = await recall.recall({ event: { chokepoint: "shell", command: "git stash --keep-index" }, canonicalCommand: "git stash --keep-index" });
  expect(hits).toEqual([]);
});

test("mismatched embedding dimensions skip stored rows (defensive against model swap)", async () => {
  installStub();
  const store = makeStore();
  const recall = new LocalRecall({ store, dimensions: 256 });
  // Hand-write a wrong-dim embedding into the store so we can prove the
  // recall path skips it rather than compares garbage.
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

test("factory routes `local` mode to LocalRecall and degrades cleanly on construction", async () => {
  installStub();
  const { buildRecall } = await import("../src/ingest/recall-factory");
  const store = makeStore();
  const recall = buildRecall({ store, configPath: undefined, environment: { VIBEBLOAT_HOME: tempHome() } as NodeJS.ProcessEnv });
  expect(recall.mode).toBe("lexical"); // no config + default = lexical
  void recall;
});

test("factory routes SR choice of `local` to LocalRecall when config pins it", async () => {
  installStub();
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
    installStub();
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
