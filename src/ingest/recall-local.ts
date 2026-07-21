import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncidentStore } from "./incidents-store";
import {
  type RecallHit,
  type RecallRequest,
  type SemanticRecall,
  commandSignature,
  cosineSimilarity,
} from "./semantic-recall";

// Force the WASM ONNX runtime before transformers.js's first import — the package
// auto-picks onnxruntime-node in Node-shaped runtimes (incl. Bun), which would
// pull in a native binding we explicitly want to avoid. Ponytail: setting
// `globalThis[Symbol.for('onnxruntime')]` is the supported hook the package
// checks in `src/backends/onnx.js`; the import side-effect resolves the binding.
import * as ONNX_WEB from "onnxruntime-web";
(globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = ONNX_WEB;

interface TransformersModule {
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

interface Tensor {
  data: Float32Array;
  dims: readonly number[];
}

const embeddingModelId = "Xenova/all-MiniLM-L6-v2";
const defaultEmbeddingDimensions = 384;
const maximumCandidates = 64;

/**
 * Adapter shape the LocalRecall class needs from `@huggingface/transformers`.
 * Held as a static slot so tests can swap a deterministic stub without booting
 * a 384-dim ONNX model in CI.
 */
let transformersModule: TransformersModule | undefined;

export function setTransformersModuleForTesting(module: TransformersModule | undefined): void {
  transformersModule = module;
}

async function loadTransformersModule(): Promise<TransformersModule> {
  if (transformersModule) return transformersModule;
  const imported = await import("@huggingface/transformers");
  transformersModule = imported as unknown as TransformersModule;
  return transformersModule;
}

function pipelineCacheDir(home: string): string {
  return join(home, "cache", "transformers");
}

export interface LocalRecallOptions {
  store: IncidentStore;
  /**
   * Directory the model + WASM binaries cache under. Defaults to
   * `${home}/cache/transformers` so first-run downloads land in the guard
   * home, not in the cwd. After the first fetch the model is read from here
   * with zero network.
   */
  cacheDir?: string;
  /**
   * Override the model id. Defaults to Xenova/all-MiniLM-L6-v2 — 384-dim,
   * ~23MB quantized, ships a WASM-compatible ONNX export on the HF Hub.
   */
  model?: string;
  /**
   * Override the embedding dimensions. Defaults to 384. A mismatch on recall
   * makes the adapter inert (no false matches).
   */
  dimensions?: number;
}

type PipelineFn = (input: string, options?: Record<string, unknown>) => Promise<Tensor>;

/**
 * Local neural embedder: ships the model weights to disk on first use and
 * embeds offline thereafter. No API key, no network at inference. Cosine
 * k-NN over Float32 stored alongside the lexical Jaccard index — both backends
 * share the same `incidentStore.embedding` column.
 *
 * Async by design — inference takes tens of milliseconds and would explode the
 * sync enforcement hot path. The factory's `buildSyncRecall` already routes the
 * hot path to lexical when the configured mode is `local`; this class composes
 * into the async `recallAdvisory` side door like `EmbedRecall` does.
 *
 * Ponytail: degrading gracefully (return [] on recall, store without embedding
 * on record) is the contract for "first run needs network to pull the model".
 * A failed model load never breaks the hot path — it just opts out of recall.
 */
export class LocalRecall implements SemanticRecall {
  readonly mode = "local" as const;
  readonly #store: IncidentStore;
  readonly #cacheDir: string;
  readonly #model: string;
  readonly #dimensions: number;
  #pipeline: PipelineFn | undefined;
  #pipelinePromise: Promise<PipelineFn | undefined> | undefined;
  #unavailable: { reason: string } | undefined;

  constructor(options: LocalRecallOptions) {
    this.#store = options.store;
    this.#cacheDir = options.cacheDir ?? pipelineCacheDir(process.env.VIBEBLOAT_HOME ?? process.env.HOME ?? process.cwd());
    this.#model = options.model ?? embeddingModelId;
    this.#dimensions = options.dimensions ?? defaultEmbeddingDimensions;
  }

  /** Test/operator visibility into degraded state. */
  get unavailableReason(): string | undefined {
    return this.#unavailable?.reason;
  }

  /** Test/operator visibility into which dimensions this adapter expects. */
  get dimensions(): number {
    return this.#dimensions;
  }

  async #getPipeline(): Promise<PipelineFn | undefined> {
    if (this.#pipeline) return this.#pipeline;
    if (this.#pipelinePromise) return this.#pipelinePromise;
    this.#pipelinePromise = (async () => {
      try {
        const module = await loadTransformersModule();
        module.env.cacheDir = this.#cacheDir;
        module.env.allowLocalModels = true;
        module.env.allowRemoteModels = true;
        module.env.useFs = true;
        module.env.useBrowserCache = false;
        // Allow the WASM backend to find onnxruntime-web's compiled artifacts
        // shipped in node_modules — no native binding required.
        const wasmPaths = join(process.cwd(), "node_modules", "onnxruntime-web", "dist");
        const wasmPathsFallback = join(process.cwd(), "node_modules", "@huggingface", "transformers", "dist");
        module.env.backends.onnx = {
          ...(module.env.backends.onnx ?? {}),
          wasm: {
            wasmPaths: fileExists(wasmPaths) ? wasmPaths : fileExists(wasmPathsFallback) ? wasmPathsFallback : wasmPaths,
            proxy: false,
            numThreads: 1,
          },
        };
        mkdirSync(this.#cacheDir, { recursive: true });
        const pipe = await module.pipeline("feature-extraction", this.#model, { quantized: true });
        this.#pipeline = pipe as unknown as PipelineFn;
        return this.#pipeline;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.#unavailable = { reason };
        this.#pipelinePromise = undefined;
        return undefined;
      }
    })();
    return this.#pipelinePromise;
  }

  async recall(request: RecallRequest): Promise<RecallHit[]> {
    if (this.#unavailable) return [];
    if (this.#store.isEmpty()) return [];
    if (!request.canonicalCommand.trim()) return [];
    const pipe = await this.#getPipeline();
    if (!pipe) return [];
    let query: Float32Array;
    try {
      const output = await pipe(request.canonicalCommand, { pooling: "mean", normalize: true });
      query = output.data;
    } catch {
      return [];
    }
    if (query.length !== this.#dimensions) return [];
    const limit = request.limit ?? 5;
    const scored: { incidentId: string; command: string; condition: string; consequence: string; similarity: number }[] = [];
    for (const incident of this.#store.all()) {
      if (!incident.embedding) continue;
      const stored = new Float32Array(incident.embedding.buffer, incident.embedding.byteOffset, incident.embedding.byteLength / 4);
      if (stored.length !== this.#dimensions) continue;
      const similarity = cosineSimilarity(query, stored);
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
    if (this.#unavailable) {
      // Ponytail: degrade the same way recall does — losing the embedding beats
      // crashing the mining path or refusing to record the incident at all.
      this.#store.record({
        incidentId: args.incidentId,
        command: args.command,
        argsContains: args.argsContains,
        argsAnyOf: args.argsAnyOf,
        condition: args.condition,
        consequence: args.consequence,
        signature: commandSignature(args.canonicalCommand),
        recordedAt: args.recordedAt,
      });
      return;
    }
    const pipe = await this.#getPipeline();
    let embedding: Float32Array | undefined;
    if (pipe) {
      try {
        const output = await pipe(args.canonicalCommand, { pooling: "mean", normalize: true });
        embedding = output.data.length === this.#dimensions ? output.data : undefined;
      } catch {
        embedding = undefined;
      }
    }
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

function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

export function createLocalRecall(options: LocalRecallOptions): LocalRecall {
  return new LocalRecall(options);
}

export const localRecallDimensions = defaultEmbeddingDimensions;
export const localRecallModelId = embeddingModelId;
