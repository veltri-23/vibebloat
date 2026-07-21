import { writeRecallConfig } from "../ingest/recall-config";
import type { RecallMode } from "../ingest/semantic-recall";

/**
 * Persist the onboarding recall choice to .vibebloat/config.toml. Keeps the
 * writer here so the gate machine doesn't have to know about file I/O.
 */
export interface PersistRecallChoiceOptions {
  configPath: string;
  mode: RecallMode;
  /** Optional embedding key to embed alongside the mode. */
  embedApiKey?: string;
}

export function persistRecallChoice(options: PersistRecallChoiceOptions): void {
  writeRecallConfig(options.configPath, {
    mode: options.mode,
    ...(options.embedApiKey !== undefined ? { embedApiKey: options.embedApiKey } : {}),
  });
}