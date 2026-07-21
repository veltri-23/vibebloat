import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RecallMode } from "./semantic-recall";

/**
 * Tiny TOML reader for the `[semantic]` block only. We only ever write a
 * handful of keys; pulling a TOML dep for that is over-engineering. Anything
 * else in the file is preserved verbatim so other tools don't lose their
 * writes.
 */
export interface RecallConfig {
  mode: RecallMode;
  /** When `embed` is selected and the key isn't already in the environment. */
  embedApiKey?: string;
  /**
   * Optional bridge for GBrain users: when true, a recorded incident is also
   * pushed to a reachable GBrain instance. Defaults to false; the exporter
   * never blocks or fails the proposal path.
   */
  gbrainExport?: boolean;
}

const validModes: ReadonlySet<RecallMode> = new Set<RecallMode>(["lexical", "embed", "local", "off"]);

function parseRecallValue(raw: string): RecallMode | undefined {
  const normalized = raw.trim().toLowerCase();
  return validModes.has(normalized as RecallMode) ? (normalized as RecallMode) : undefined;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a single top-level key/value from the `[semantic]` block. Returns
 * undefined for keys we don't own; preserves the raw line for round-trip.
 */
function parseSemanticLine(line: string): { mode?: RecallMode; embedApiKey?: string; gbrainExport?: boolean; preserve: string } {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(line);
  if (!match) return { preserve: line };
  const key = match[1]!;
  const rawValue = match[2]!;
  if (key === "recall") {
    const mode = parseRecallValue(rawValue);
    if (mode) return { mode, preserve: line };
  }
  if (key === "embed_api_key") {
    return { embedApiKey: stripQuotes(rawValue), preserve: line };
  }
  if (key === "gbrain_export") {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "true") return { gbrainExport: true, preserve: line };
    if (normalized === "false") return { gbrainExport: false, preserve: line };
  }
  return { preserve: line };
}

/** Parse the `[semantic]` block out of a vibebloat config file. */
export function readRecallConfig(path: string): RecallConfig | undefined {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const lines = source.split(/\r?\n/);
  let inSemanticBlock = false;
  let mode: RecallMode | undefined;
  let embedApiKey: string | undefined;
  let gbrainExport: boolean | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inSemanticBlock = trimmed === "[semantic]";
      continue;
    }
    if (!inSemanticBlock || !trimmed) continue;
    const parsed = parseSemanticLine(line);
    if (parsed.mode) mode = parsed.mode;
    if (parsed.embedApiKey !== undefined) embedApiKey = parsed.embedApiKey;
    if (parsed.gbrainExport !== undefined) gbrainExport = parsed.gbrainExport;
  }
  if (!mode) return undefined;
  const config: RecallConfig = { mode };
  if (embedApiKey !== undefined) config.embedApiKey = embedApiKey;
  if (gbrainExport !== undefined) config.gbrainExport = gbrainExport;
  return config;
}

function formatValue(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Replace (or insert) the `[semantic]` block. Preserves every other line in
 * the file so unrelated config keeps its bytes. Drops the previous block's
 * contents — callers re-derive them from the new `RecallConfig` so the file
 * never accumulates stale `recall = ` lines that would shadow the latest one.
 * Creates parent directories if missing.
 */
export function writeRecallConfig(path: string, config: RecallConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  let existing: string[] = [];
  try {
    existing = readFileSync(path, "utf8").split(/\r?\n/);
  } catch {
    existing = [];
  }
  const rebuilt: string[] = [];
  let inSemanticBlock = false;
  for (const line of existing) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inSemanticBlock = trimmed === "[semantic]";
      if (inSemanticBlock) continue;
      rebuilt.push(line);
      continue;
    }
    if (inSemanticBlock) continue;
    rebuilt.push(line);
  }
  const newBlock = [`[semantic]`, `recall = ${formatValue(config.mode)}`];
  if (config.embedApiKey !== undefined) newBlock.push(`embed_api_key = ${formatValue(config.embedApiKey)}`);
  if (config.gbrainExport !== undefined) newBlock.push(`gbrain_export = ${config.gbrainExport ? "true" : "false"}`);
  while (rebuilt.length > 0 && rebuilt[rebuilt.length - 1] === "") rebuilt.pop();
  rebuilt.push(...newBlock, "");
  writeFileSync(path, rebuilt.join("\n"), "utf8");
}