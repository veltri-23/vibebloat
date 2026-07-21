import { spawnSync } from "node:child_process";
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
const maximumCandidates = 64;
const workerPath = fileURLToPath(new URL("./embed-worker.mjs", import.meta.url));

/** Response shape from `embed-worker.mjs`. */
interface WorkerResponse {
  ok: boolean;
  dims?: number;
  vectors?: number[][];
  error?: string;
}

/**
 * How we run the neural model. The vibebloat CLI is a Bun process, and
 * onnxruntime-node's native binding registers ZERO execution providers under
 * Bun on Windows (`Unsupported device: "cpu"`). The transformers *web* build
 * clears that but has no filesystem under Bun. The only combination that
 * actually embeds is the transformers *node* build under real Node — so we
 * shell out to `node` for the model and keep Bun on the fast path. `node` is
 * present wherever `npx` installs. A missing/failed worker degrades to no
 * recall; it never throws into the enforcement path.
 *
 * Tests inject a deterministic embedder via `setEmbedderForTesting` so the
 * suite exercises the real record/recall/cosine logic without booting a
 * 384-dim ONNX model — the ONE real-model test drives the worker directly.
 */
export type Embedder = (texts: readonly string[]) => Float32Array[] | undefined;

let injectedEmbedder: Embedder | undefined;

export function setEmbedderForTesting(embedder: Embedder | undefined): void {
  injectedEmbedder = embedder;
}

function nodeBinary(): string {
  return process.env.VIBEBLOAT_NODE?.trim() || "node";
}

/**
 * Spawn the node sidecar and embed each text. Synchronous by construction: the
 * caller is already async or a short-lived scan/hook process, and a blocking
 * child keeps the protocol dead simple (one request, one response). Returns
 * undefined on any failure so callers degrade cleanly.
 *
 * ponytail: one spawn per call. Fine for scan-time batch (pass all texts at
 * once) and the once-per-command hot path; a persistent worker only pays off
 * if per-command latency ever matters.
 */
function spawnEmbedder(cacheDir: string, model: string): Embedder {
  return (texts) => {
    if (texts.length === 0) return [];
    const result = spawnSync(nodeBinary(), [workerPath], {
      input: JSON.stringify({ texts, model, cacheDir }),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    let parsed: WorkerResponse;
    try {
      parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
      return undefined;
    }
    if (!parsed.ok || !Array.isArray(parsed.vectors)) return undefined;
    return parsed.vectors.map((vector) => Float32Array.from(vector));
  };
}

export interface LocalRecallOptions {
  store: IncidentStore;
  /** Where the model caches. Defaults under the guard home. */
  cacheDir?: string;
  /** Override the model id. Defaults to Xenova/all-MiniLM-L6-v2 (384-dim). */
  model?: string;
  /** Override embedding dimensions. A mismatch makes recall inert (no false hits). */
  dimensions?: number;
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
    const cacheDir = options.cacheDir
      ?? `${process.env.VIBEBLOAT_HOME ?? process.env.HOME ?? process.cwd()}/cache/transformers`;
    const model = options.model ?? embeddingModelId;
    this.#embed = (texts) => (injectedEmbedder ?? spawnEmbedder(cacheDir, model))(texts);
  }

  get unavailableReason(): string | undefined {
    return this.#unavailableReason;
  }

  get dimensions(): number {
    return this.#dimensions;
  }

  #embedOne(text: string): Float32Array | undefined {
    let vectors: Float32Array[] | undefined;
    try {
      vectors = this.#embed([text]);
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
    const queryVector = this.#embedOne(query);
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
    const embedding = this.#embedOne(args.canonicalCommand);
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
