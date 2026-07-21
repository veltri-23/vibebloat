import { existsSync } from "node:fs";
import { readRecallConfig } from "./recall-config";
import type { IncidentStore } from "./incidents-store";
import { EmbedRecall, createEmbedRecall } from "./recall-embed";
import { LexicalRecall, createLexicalRecall } from "./recall-lexical";
import { LocalRecall, createLocalRecall } from "./recall-local";
import type { RecallHit, RecallMode, SemanticRecall, SyncSemanticRecall } from "./semantic-recall";

/**
 * Default when no config pins a mode: `lexical` — offline, free, and works
 * without trusting the user's environment with a network call. The SR gate
 * writes the user's actual choice; that choice takes precedence over this
 * default. `embed` is opt-in even when OPENAI_API_KEY is present, so a key
 * on disk never silently flips the hot path to a paid backend.
 */
export function inferDefaultRecallMode(_environment: NodeJS.ProcessEnv = process.env): RecallMode {
  return "lexical";
}

export interface BuildRecallOptions {
  store: IncidentStore;
  /** Optional config path; when missing, infer default from environment. */
  configPath?: string;
  environment?: NodeJS.ProcessEnv;
  /** When true, fetch must come from this implementation (test-only). */
  fetchImpl?: typeof fetch;
}

/**
 * One place that knows every backend and how to pick it. Backends are
 * additive: a future embedder adds a case here without touching the hot
 * path or any of the existing recall tests.
 */
export function buildRecall(options: BuildRecallOptions): SemanticRecall {
  const environment = options.environment ?? process.env;
  const config = options.configPath && existsSync(options.configPath)
    ? readRecallConfig(options.configPath)
    : undefined;
  const mode: RecallMode = config?.mode ?? inferDefaultRecallMode(environment);
  switch (mode) {
    case "off":
      return createOffRecall();
    case "embed": {
      const apiKey = config?.embedApiKey ?? environment.OPENAI_API_KEY;
      if (!apiKey) return createLexicalRecall({ store: options.store });
      const args: ConstructorParameters<typeof EmbedRecall>[0] = { store: options.store, apiKey };
      if (options.fetchImpl) args.fetchImpl = options.fetchImpl;
      return createEmbedRecall(args);
    }
    case "local":
      return createLocalRecall({ store: options.store });
    case "lexical":
    default:
      return createLexicalRecall({ store: options.store });
  }
}

/**
 * Sync-only builder. The hot path can only use a sync adapter — lexical or off.
 * `embed`/`local` cannot satisfy SyncSemanticRecall, so they fall back to
 * lexical here (embed only gets a network adapter at scan-time, never on the
 * hot path).
 */
export function buildSyncRecall(options: BuildRecallOptions): SyncSemanticRecall {
  const adapter = buildRecall(options);
  if (adapter.mode === "lexical" || adapter.mode === "off") {
    return adapter as SyncSemanticRecall;
  }
  // Embed + local are async by design; the hot path gets the safe fallback.
  return createLexicalRecall({ store: options.store });
}

/**
 * Null-object recall used when the user picks `off`. Same interface, same
 * no-op behavior on the hot path: no DB hit, no work, no latency.
 */
export class OffRecall implements SyncSemanticRecall {
  readonly mode = "off" as const;
  recall(): RecallHit[] {
    return [];
  }
  record(): void {
    // Drop on the floor. User asked for `off`; we keep the hot path honest.
  }
}

export function createOffRecall(): OffRecall {
  return new OffRecall();
}