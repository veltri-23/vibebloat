import type { IncidentStore } from "./incidents-store";
import {
  type RecallHit,
  type RecallRequest,
  type SemanticRecall,
  commandSignature,
  cosineSimilarity,
} from "./semantic-recall";

const maximumCandidates = 64;
const embeddingDimensions = 1536;
const openAiEndpoint = "https://api.openai.com/v1/embeddings";
const embedModel = "text-embedding-3-small";

export interface EmbedRecallOptions {
  store: IncidentStore;
  apiKey: string;
  /** Override fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Override the model id when the mining key has a preferred variant. */
  model?: string;
  /** Short-circuit while we're already embedding the same canonical command. */
  emptyCacheMs?: number;
}

interface CacheState {
  expiresAt: number;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[] }>;
}

async function fetchEmbedding(text: string, apiKey: string, model: string, fetchImpl: typeof fetch): Promise<Float32Array> {
  const response = await fetchImpl(openAiEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: text, model }),
  });
  if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`);
  const payload = (await response.json()) as EmbeddingResponse;
  const values = payload.data[0]?.embedding;
  if (!Array.isArray(values)) throw new Error("Embedding response missing data.");
  return Float32Array.from(values);
}

export class EmbedRecall implements SemanticRecall {
  readonly mode = "embed" as const;
  readonly #store: IncidentStore;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #model: string;
  readonly #emptyCacheMs: number;
  #cache: CacheState | undefined;

  constructor(options: EmbedRecallOptions) {
    this.#store = options.store;
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#model = options.model ?? embedModel;
    this.#emptyCacheMs = options.emptyCacheMs ?? 1_000;
  }

  async recall(request: RecallRequest): Promise<RecallHit[]> {
    const now = Date.now();
    if (this.#cache && this.#cache.expiresAt > now) return [];
    if (this.#store.isEmpty()) {
      this.#cache = { expiresAt: now + this.#emptyCacheMs };
      return [];
    }
    if (!request.canonicalCommand.trim()) return [];
    const query = await fetchEmbedding(request.canonicalCommand, this.#apiKey, this.#model, this.#fetch);
    if (query.length !== embeddingDimensions) return [];
    const limit = request.limit ?? 5;
    const scored: { incidentId: string; command: string; condition: string; consequence: string; similarity: number }[] = [];
    for (const incident of this.#store.all()) {
      if (!incident.embedding) continue;
      const stored = new Float32Array(incident.embedding.buffer, incident.embedding.byteOffset, incident.embedding.byteLength / 4);
      if (stored.length !== embeddingDimensions) continue;
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
    const embedding = await fetchEmbedding(args.canonicalCommand, this.#apiKey, this.#model, this.#fetch);
    this.#store.record({
      incidentId: args.incidentId,
      command: args.command,
      argsContains: args.argsContains,
      argsAnyOf: args.argsAnyOf,
      condition: args.condition,
      consequence: args.consequence,
      signature: commandSignature(args.canonicalCommand),
      embedding,
      recordedAt: args.recordedAt,
    });
    this.#cache = undefined;
  }

  close(): void {
    this.#store.close();
  }
}

export function createEmbedRecall(options: EmbedRecallOptions): EmbedRecall {
  return new EmbedRecall(options);
}

export const embedRecallDimensions = embeddingDimensions;