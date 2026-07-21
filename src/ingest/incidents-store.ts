import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * Stored shape of a past incident. We keep the same command+condition+consequence
 * fields the compiler already knows about so recall can narrate without joining
 * another table.
 */
export interface StoredIncident {
  incidentId: string;
  command: string;
  argsContains: readonly string[];
  argsAnyOf: readonly string[];
  condition: string;
  consequence: string;
  /** Opaque vector bytes. Empty when lexical-only. */
  embedding: Buffer | null;
  /** sha256 of the command + key args, lets us dedupe repeats cheaply. */
  signature: string;
  recordedAt: string;
}

export interface IncidentWrite {
  incidentId: string;
  command: string;
  argsContains?: readonly string[];
  argsAnyOf?: readonly string[];
  condition: string;
  consequence: string;
  signature: string;
  embedding?: Float32Array;
  recordedAt?: string;
}

export interface IncidentStoreOptions {
  path: string;
}

interface IncidentRow {
  incident_id: string;
  command: string;
  args_contains: string;
  args_any_of: string;
  condition: string;
  consequence: string;
  embedding: Buffer | null;
  signature: string;
  recorded_at: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseArgs(serialized: string): string[] {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function rowToIncident(row: IncidentRow): StoredIncident {
  return {
    incidentId: row.incident_id,
    command: row.command,
    argsContains: parseArgs(row.args_contains),
    argsAnyOf: parseArgs(row.args_any_of),
    condition: row.condition,
    consequence: row.consequence,
    embedding: row.embedding,
    signature: row.signature,
    recordedAt: row.recorded_at,
  };
}

export class IncidentStore {
  readonly #database: Database;
  readonly #path: string;

  constructor(options: IncidentStoreOptions) {
    mkdirSync(dirname(options.path), { recursive: true });
    this.#path = options.path;
    this.#database = new Database(options.path, { create: true });
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS incidents (
        incident_id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        args_contains TEXT NOT NULL DEFAULT '[]',
        args_any_of TEXT NOT NULL DEFAULT '[]',
        condition TEXT NOT NULL,
        consequence TEXT NOT NULL,
        embedding BLOB,
        signature TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_signature ON incidents(signature);
    `);
  }

  get path(): string {
    return this.#path;
  }

  close(): void {
    this.#database.close(true);
  }

  /** Cheap, in-memory check used to short-circuit lexical recall on empty stores. */
  isEmpty(): boolean {
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM incidents").get() as { count: number };
    return row.count === 0;
  }

  record(incident: IncidentWrite): void {
    const recordedAt = incident.recordedAt ?? todayIso();
    const embedding = incident.embedding
      ? Buffer.from(incident.embedding.buffer, incident.embedding.byteOffset, incident.embedding.byteLength)
      : null;
    const argsContains = JSON.stringify([...incident.argsContains ?? []]);
    const argsAnyOf = JSON.stringify([...incident.argsAnyOf ?? []]);
    this.#database
      .prepare(`INSERT OR REPLACE INTO incidents(incident_id, command, args_contains, args_any_of, condition, consequence, embedding, signature, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        incident.incidentId,
        incident.command,
        argsContains,
        argsAnyOf,
        incident.condition,
        incident.consequence,
        embedding,
        incident.signature,
        recordedAt,
      );
  }

  all(): StoredIncident[] {
    const rows = this.#database.prepare("SELECT incident_id, command, args_contains, args_any_of, condition, consequence, embedding, signature, recorded_at FROM incidents").all() as IncidentRow[];
    return rows.map(rowToIncident);
  }

  findBySignature(signature: string): StoredIncident | undefined {
    const row = this.#database.prepare("SELECT incident_id, command, args_contains, args_any_of, condition, consequence, embedding, signature, recorded_at FROM incidents WHERE signature = ?").get(signature) as IncidentRow | undefined;
    return row ? rowToIncident(row) : undefined;
  }

  count(): number {
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM incidents").get() as { count: number };
    return row.count;
  }
}

export function defaultIncidentStorePath(repoRoot: string, home: string): string {
  return join(home, "cache", "incidents", `${encodeURIComponent(repoRoot)}.sqlite`);
}