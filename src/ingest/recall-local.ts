import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncidentStore } from "./incidents-store";
import {
  type RecallHit,
  type RecallRequest,
  type SemanticRecall,
  commandSignature,
  cosineSimilarity,
  localRecallWarnThreshold,
} from "./semantic-recall";

const embeddingModelId = "Xenova/all-MiniLM-L6-v2";
const defaultEmbeddingDimensions = 384;
const defaultWorkerTimeoutMs = 5_000;
const maximumWorkerOutputBytes = 1_048_576;
const maximumCandidates = 64;
const defaultWorkerPath = fileURLToPath(new URL("./embed-worker.mjs", import.meta.url));
const unavailableAdvisory =
  "WHAT skipped: local semantic recall is unavailable.\n" +
  "WHY: optional @huggingface/transformers and onnxruntime-node runtime could not load.\n" +
  "FIX: npm install @huggingface/transformers onnxruntime-node";

/** Response shape from `embed-worker.mjs`. */
interface WorkerResponse {
  ok: boolean;
  dims?: number;
  vectors?: number[][];
  error?: { code: string; message: string };
}

/**
 * How we run the neural model. The vibebloat CLI is a Bun process, and
 * onnxruntime-node's native binding registers ZERO execution providers under
 * Bun on Windows (`Unsupported device: "cpu"`). The transformers *web* build
 * clears that but has no filesystem under Bun. The only combination that
 * actually embeds is the transformers *node* build under real Node — so we
 * spawn `node` directly for the model and keep Bun on the fast path. `node`
 * is present wherever `npx` installs. A missing/failed worker degrades to no
 * recall; it never throws into the enforcement path.
 *
 * Tests inject a deterministic embedder via `setEmbedderForTesting` so the
 * suite exercises the real record/recall/cosine logic without booting a
 * 384-dim ONNX model — the ONE real-model test drives the worker directly.
 */
export type Embedder = (
  texts: readonly string[],
) => Float32Array[] | undefined | Promise<Float32Array[] | undefined>;

let injectedEmbedder: Embedder | undefined;

export function setEmbedderForTesting(embedder: Embedder | undefined): void {
  injectedEmbedder = embedder;
}

function nodeBinary(): string {
  return process.env.VIBEBLOAT_NODE?.trim() || "node";
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumWorkerOutputBytes) {
        onLimit();
        throw new Error("embedding-worker-output-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

/**
 * Spawn Node directly (never through a shell) and embed each text. Bun keeps
 * the hook event loop live while the worker runs, then kills it at a short
 * deadline. Missing/incompatible Node, bad output, and timeouts all degrade to
 * undefined so recall can never break enforcement.
 *
 * ponytail: one spawn per call. Fine for the once-per-command advisory path; a
 * persistent worker only pays off if measured latency later demands it.
 */
function spawnEmbedder(
  cacheDir: string,
  model: string,
  binary: string,
  sidecarPath: string,
  timeoutMs: number,
): Embedder {
  return async (texts) => {
    if (texts.length === 0) return [];
    try {
      const child = Bun.spawn({
        cmd: [binary, sidecarPath, "--model", model, "--cache-dir", cacheDir],
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      const kill = () => {
        try { child.kill(); } catch { /* already exited */ }
      };
      child.stdin.write(JSON.stringify({ texts }));
      child.stdin.end();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, timeoutMs);
      try {
        const stdoutPromise = readBoundedOutput(child.stdout, kill);
        const exitCode = await child.exited;
        const stdout = await stdoutPromise;
        if (timedOut || exitCode !== 0 || !stdout) return undefined;
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as WorkerResponse;
        if (!parsed.ok || !Array.isArray(parsed.vectors)) return undefined;
        return parsed.vectors.map((vector) => Float32Array.from(vector));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return undefined;
    }
  };
}

export interface LocalRecallOptions {
  store: IncidentStore;
  /** Dedicated model cache. Restricted by worker policy; defaults under guard home. */
  cacheDir?: string;
  /** Override embedding dimensions. A mismatch makes recall inert (no false hits). */
  dimensions?: number;
  /** Node executable override. Primarily useful for tests and nonstandard installs. */
  nodeBinary?: string;
  /** Sidecar path override for tests. */
  workerPath?: string;
  /** Worker deadline. Hook-safe default is 5 seconds. */
  workerTimeoutMs?: number;
}

/**
 * Local neural embedder for `recall = local`: offline semantic recall with no
 * API key. Embeds via a Node sidecar (see Embedder note above), stores Float32
 * vectors in the shared `incidents.embedding` column, and scores recall by
 * cosine k-NN. Carries its own `warnThreshold` because cosine and the lexical
 * Jaccard scale are not comparable.
 *
 * Async by design — spawning the model would explode the sync enforcement hot
 * path, so `buildSyncRecall` routes the hot path to lexical and this backend
 * surfaces through the async `recallAdvisory` side door. A failed embed always
 * degrades: recall returns [], record stores the incident without a vector so
 * a later working model can still match it lexically.
 */
export class LocalRecall implements SemanticRecall {
  readonly mode = "local" as const;
  readonly warnThreshold = localRecallWarnThreshold;
  readonly #store: IncidentStore;
  readonly #dimensions: number;
  readonly #embed: Embedder;
  #probed = false;
  #unavailableReason: string | undefined;

  constructor(options: LocalRecallOptions) {
    this.#store = options.store;
    this.#dimensions = options.dimensions ?? defaultEmbeddingDimensions;
    const cacheDir = resolve(options.cacheDir
      ?? join(process.env.VIBEBLOAT_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd(), "cache", "transformers"));
    const model = embeddingModelId;
    const binary = options.nodeBinary?.trim() || nodeBinary();
    const sidecarPath = options.workerPath ?? defaultWorkerPath;
    const configuredTimeoutMs = options.workerTimeoutMs;
    const timeoutMs = typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : defaultWorkerTimeoutMs;
    const workerEmbedder = spawnEmbedder(cacheDir, model, binary, sidecarPath, timeoutMs);
    this.#embed = (texts) => (injectedEmbedder ?? workerEmbedder)(texts);
  }

  get unavailableReason(): string | undefined {
    return this.#unavailableReason;
  }

  get unavailableAdvisory(): string | undefined {
    return this.#unavailableReason ? unavailableAdvisory : undefined;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  async #embedOne(text: string): Promise<Float32Array | undefined> {
    let vectors: Float32Array[] | undefined;
    try {
      vectors = await this.#embed([text]);
    } catch (error) {
      vectors = undefined;
      this.#unavailableReason = error instanceof Error ? error.message : String(error);
    }
    if (!this.#probed) {
      this.#probed = true;
      if (!vectors) this.#unavailableReason ??= "embedding worker unavailable";
    }
    const vector = vectors?.[0];
    if (!vector || vector.length !== this.#dimensions) return undefined;
    return vector;
  }

  async recall(request: RecallRequest): Promise<RecallHit[]> {
    if (this.#store.isEmpty()) return [];
    const query = request.canonicalCommand.trim();
    if (!query) return [];
    const queryVector = await this.#embedOne(query);
    if (!queryVector) return [];
    const limit = request.limit ?? 5;
    const scored: RecallHit[] = [];
    for (const incident of this.#store.all()) {
      if (!incident.embedding) continue;
      const stored = new Float32Array(
        incident.embedding.buffer,
        incident.embedding.byteOffset,
        incident.embedding.byteLength / 4,
      );
      if (stored.length !== this.#dimensions) continue;
      const similarity = cosineSimilarity(queryVector, stored);
      if (similarity <= 0) continue;
      scored.push({
        incidentId: incident.incidentId,
        command: incident.command,
        condition: incident.condition,
        consequence: incident.consequence,
        similarity,
      });
    }
    scored.sort((left, right) => right.similarity - left.similarity);
    return scored.slice(0, Math.min(limit, maximumCandidates));
  }

  async record(args: {
    incidentId: string;
    command: string;
    argsContains?: readonly string[];
    argsAnyOf?: readonly string[];
    condition: string;
    consequence: string;
    canonicalCommand: string;
    recordedAt?: string;
  }): Promise<void> {
    const embedding = await this.#embedOne(args.canonicalCommand);
    this.#store.record({
      incidentId: args.incidentId,
      command: args.command,
      argsContains: args.argsContains,
      argsAnyOf: args.argsAnyOf,
      condition: args.condition,
      consequence: args.consequence,
      signature: commandSignature(args.canonicalCommand),
      ...(embedding ? { embedding } : {}),
      recordedAt: args.recordedAt,
    });
  }

  close(): void {
    this.#store.close();
  }
}

export function createLocalRecall(options: LocalRecallOptions): LocalRecall {
  return new LocalRecall(options);
}

export const localRecallDimensions = defaultEmbeddingDimensions;
export const localRecallModelId = embeddingModelId;
