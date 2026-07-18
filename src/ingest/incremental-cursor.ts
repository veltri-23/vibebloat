import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { readValidatedCheckpoint, writeCheckpoint } from "./resume";
import { scanHistory, type ScanOptions } from "./scan";
import type { HistoryChunk, HistorySource } from "./types";

const cursorStage = "returning-cursor";
const cursorSchemaVersion = 1;
const defaultMaxSessionsPerSource = 128;
const sourceIds: readonly HistorySource[] = ["claude-code", "codex", "hermes"];

interface CursorSession {
  sessionDigest: string;
  messageIndex: number;
  chunkIndex: number;
}

interface SourceCursor {
  source: HistorySource;
  sessions: CursorSession[];
}

interface IncrementalCursor {
  schemaVersion: 1;
  sources: SourceCursor[];
}

export interface IncrementalScanOptions<Incident> {
  directory: string;
  loadHistory(): Promise<HistoryChunk[]>;
  scan: ScanOptions<Incident>;
  maxSessionsPerSource?: number;
}

export interface IncrementalScanResult {
  status: "ingested" | "paused";
  chunksScanned: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key));
}

function isPosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isCursorSession(value: unknown): value is CursorSession {
  return isRecord(value)
    && hasExactKeys(value, ["sessionDigest", "messageIndex", "chunkIndex"])
    && typeof value.sessionDigest === "string"
    && /^[a-f0-9]{64}$/.test(value.sessionDigest)
    && isPosition(value.messageIndex)
    && isPosition(value.chunkIndex);
}

function isCursor(value: unknown, maxSessionsPerSource: number): value is IncrementalCursor {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "sources"])
    || value.schemaVersion !== cursorSchemaVersion
    || !Array.isArray(value.sources)
    || value.sources.length > sourceIds.length) return false;
  const seenSources = new Set<HistorySource>();
  return value.sources.every((entry) => isRecord(entry)
    && hasExactKeys(entry, ["source", "sessions"])
    && sourceIds.includes(entry.source as HistorySource)
    && !seenSources.has(entry.source as HistorySource)
    && (seenSources.add(entry.source as HistorySource), true)
    && Array.isArray(entry.sessions)
    && entry.sessions.length <= maxSessionsPerSource
    && entry.sessions.every(isCursorSession)
    && new Set(entry.sessions.map(({ sessionDigest }) => sessionDigest)).size === entry.sessions.length);
}

function assertLocalDirectory(directory: string): void {
  if (!isAbsolute(directory) || /^(?:\\\\|\/\/)/.test(directory) || resolve(directory) !== directory) {
    throw new Error("Returning scan cursor must use an absolute local directory.");
  }
}

function maxSessions(value: number | undefined): number {
  const resolved = value ?? defaultMaxSessionsPerSource;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 1_024) {
    throw new Error("Returning scan cursor session bound is invalid.");
  }
  return resolved;
}

function sessionDigest(chunk: Pick<HistoryChunk, "source" | "sessionId">): string {
  return createHash("sha256").update(`${chunk.source}\u0000${chunk.sessionId}`).digest("hex");
}

function isCursorChunk(chunk: unknown): chunk is HistoryChunk {
  return isRecord(chunk)
    && sourceIds.includes(chunk.source as HistorySource)
    && typeof chunk.sessionId === "string"
    && chunk.sessionId.length > 0
    && chunk.sessionId.length <= 1_024
    && isPosition(chunk.messageIndex)
    && isPosition(chunk.chunkIndex);
}

function isAfter(chunk: HistoryChunk, cursor: CursorSession | undefined): boolean {
  if (!cursor) return true;
  return chunk.messageIndex > cursor.messageIndex
    || (chunk.messageIndex === cursor.messageIndex && chunk.chunkIndex > cursor.chunkIndex);
}

function comparePosition(left: CursorSession, right: CursorSession): number {
  return left.messageIndex - right.messageIndex || left.chunkIndex - right.chunkIndex;
}

function cursorBySource(cursor: IncrementalCursor): Map<HistorySource, Map<string, CursorSession>> {
  return new Map(cursor.sources.map(({ source, sessions }) => [source, new Map(sessions.map((session) => [session.sessionDigest, session]))]));
}

function buildCursor(chunks: readonly HistoryChunk[], existing: IncrementalCursor, maxPerSource: number): IncrementalCursor {
  const sessionsBySource = cursorBySource(existing);
  for (const chunk of chunks) {
    if (!sourceIds.includes(chunk.source) || !isPosition(chunk.messageIndex) || !isPosition(chunk.chunkIndex)) {
      throw new Error("Returning scan history chunk has an invalid cursor position.");
    }
    const sourceSessions = sessionsBySource.get(chunk.source) ?? new Map<string, CursorSession>();
    const digest = sessionDigest(chunk);
    const next = { sessionDigest: digest, messageIndex: chunk.messageIndex, chunkIndex: chunk.chunkIndex };
    const current = sourceSessions.get(digest);
    if (!current || comparePosition(next, current) > 0) sourceSessions.set(digest, next);
    sessionsBySource.set(chunk.source, sourceSessions);
  }
  return {
    schemaVersion: cursorSchemaVersion,
    sources: [...sessionsBySource.entries()]
      .map(([source, sessions]) => ({
        source,
        sessions: [...sessions.values()]
          .sort((left, right) => right.messageIndex - left.messageIndex || right.chunkIndex - left.chunkIndex || left.sessionDigest.localeCompare(right.sessionDigest))
          .slice(0, maxPerSource),
      }))
      .filter(({ sessions }) => sessions.length > 0)
      .sort((left, right) => left.source.localeCompare(right.source)),
  };
}

function readCursor(directory: string, maxPerSource: number): IncrementalCursor {
  const read = readValidatedCheckpoint(directory, cursorStage, (value): value is IncrementalCursor => isCursor(value, maxPerSource));
  if (read.status !== "valid") {
    throw new Error("Returning scan cursor is missing or invalid; rerun the first-run scan before scanning new history.");
  }
  return read.value;
}

/** Creates the opaque high-water mark only after a successful first-run scan. */
export function seedIncrementalCursor(
  directory: string,
  chunks: readonly HistoryChunk[],
  maxSessionsPerSource?: number,
): void {
  assertLocalDirectory(directory);
  const maxPerSource = maxSessions(maxSessionsPerSource);
  const cursor = buildCursor(chunks, { schemaVersion: cursorSchemaVersion, sources: [] }, maxPerSource);
  if (!isCursor(cursor, maxPerSource)) throw new Error("Returning scan cursor could not be safely created.");
  writeCheckpoint(directory, cursorStage, cursor);
}

/** Scans only chunks beyond an opaque, bounded local high-water mark. */
export async function scanIncrementalHistory<Incident>(options: IncrementalScanOptions<Incident>): Promise<IncrementalScanResult> {
  assertLocalDirectory(options.directory);
  if (options.scan.checkpoint) throw new Error("Returning scan must not combine resumable scan checkpoints with its cursor.");
  const maxPerSource = maxSessions(options.maxSessionsPerSource);
  const cursor = readCursor(options.directory, maxPerSource);
  const history = await options.loadHistory();
  if (!Array.isArray(history)) throw new Error("Returning scan history loader returned an invalid payload.");
  if (!history.every(isCursorChunk)) throw new Error("Returning scan history loader returned an invalid cursor position.");
  const bySource = cursorBySource(cursor);
  const incremental = history.filter((chunk) => isAfter(chunk, bySource.get(chunk.source)?.get(sessionDigest(chunk))));
  if (incremental.length === 0) return { status: "ingested", chunksScanned: 0 };

  const result = await scanHistory(incremental, options.scan);
  if (result.status === "paused") return { status: "paused", chunksScanned: incremental.length };
  const next = buildCursor(incremental, cursor, maxPerSource);
  if (!isCursor(next, maxPerSource)) throw new Error("Returning scan cursor could not be safely advanced.");
  writeCheckpoint(options.directory, cursorStage, next);
  return { status: "ingested", chunksScanned: incremental.length };
}
