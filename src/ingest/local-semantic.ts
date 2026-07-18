import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import type {
  RetrievalIntent,
  SemanticAdapter,
  SemanticHit,
  SemanticProbeResult,
  SemanticQuery,
} from "./semantic";

const maximumFileBytes = 1_048_576;
const chunkLines = 40;
const maximumTermFrequency = 4;
const skippedDirectories = new Set([
  ".git",
  ".vibebloat",
  ".next",
  ".nuxt",
  ".output",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);
const supportedIntents: RetrievalIntent[] = ["related-code", "symbol", "references", "architecture"];

export interface LocalSemanticOptions {
  home?: string;
  readFile?: typeof readFileSync;
}

interface IndexedFile {
  path: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

interface StoredChunk {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  excerpt: string;
  termScore: number;
}

function canonicalRoot(repoRoot: string): string {
  return realpathSync(repoRoot);
}

function isInsideRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function repoId(root: string): string {
  const stableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256").update(stableRoot).digest("hex");
}

export function localSemanticIndexPath(repoRoot: string, home = join(homedir(), ".vibebloat")): string {
  return join(home, "cache", "retrieval", repoId(canonicalRoot(repoRoot)), "index.sqlite");
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function shouldSkipPath(path: string): boolean {
  return normalizeRelativePath(path).split("/").some((part) => skippedDirectories.has(part));
}

function gitFiles(root: string): string[] {
  const process = Bun.spawnSync({
    cmd: ["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    stdout: "pipe",
    stderr: "ignore",
  });
  if (process.exitCode !== 0) throw new Error("local-index-git-unavailable");
  return new TextDecoder().decode(process.stdout).split("\0").filter(Boolean);
}

function indexableFiles(root: string): IndexedFile[] {
  const files: IndexedFile[] = [];
  for (const listedPath of gitFiles(root)) {
    const path = normalizeRelativePath(listedPath);
    if (!path || isAbsolute(path) || path.split("/").includes("..") || shouldSkipPath(path)) continue;
    const absolutePath = resolve(root, path);
    try {
      const link = lstatSync(absolutePath);
      if (!link.isFile() || link.isSymbolicLink()) continue;
      const realPath = realpathSync(absolutePath);
      if (!isInsideRoot(root, realPath)) continue;
      const metadata = statSync(realPath);
      if (!metadata.isFile() || metadata.size > maximumFileBytes) continue;
      files.push({ path, absolutePath: realPath, size: metadata.size, mtimeMs: metadata.mtimeMs });
    } catch {
      continue;
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function decodeText(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8_192).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function tokens(value: string): string[] {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z_][a-z0-9_-]{1,63}/g)?.slice(0, 4_096) ?? [];
}

function tokenFrequencies(value: string, path: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const token of [...tokens(value), ...tokens(path)]) {
    frequencies.set(token, Math.min(maximumTermFrequency, (frequencies.get(token) ?? 0) + 1));
  }
  return frequencies;
}

function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(dirname(path), 0o700);
  const database = new Database(path, { create: true });
  database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      excerpt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS postings (
      token TEXT NOT NULL,
      chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
      frequency INTEGER NOT NULL,
      PRIMARY KEY (token, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS postings_token ON postings(token);
    CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
  `);
  if (process.platform !== "win32") chmodSync(path, 0o600);
  return database;
}

function changed(existing: { size: number; mtime_ms: number } | null, file: IndexedFile): boolean {
  return !existing || existing.size !== file.size || existing.mtime_ms !== file.mtimeMs;
}

function touchedScore(path: string, touchedPaths: readonly string[]): number {
  const normalized = normalizeRelativePath(path).toLowerCase();
  let score = 0;
  for (const touched of touchedPaths) {
    const candidate = normalizeRelativePath(touched).toLowerCase();
    if (normalized === candidate) score = Math.max(score, 10_000);
    else if (normalized.startsWith(`${candidate}/`) || candidate.startsWith(`${normalized}/`)) score = Math.max(score, 5_000);
    else if (dirname(normalized) === dirname(candidate)) score = Math.max(score, 1_000);
  }
  return score;
}

function pathTokenScore(path: string, queryTokens: ReadonlySet<string>): number {
  return tokens(path).reduce((score, token) => score + (queryTokens.has(token) ? 100 : 0), 0);
}

function declaredSymbols(excerpt: string): string[] {
  return [...excerpt.matchAll(/\b(?:class|const|enum|function|interface|let|type|var)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!);
}

function symbolTokenScore(symbols: readonly string[], queryTokens: ReadonlySet<string>): number {
  return symbols.reduce(
    (score, symbol) => score + tokens(symbol).reduce((subtotal, token) => subtotal + (queryTokens.has(token) ? 250 : 0), 0),
    0,
  );
}

export class LocalSemanticAdapter implements SemanticAdapter {
  readonly id = "local" as const;
  readonly #home: string;
  readonly #readFile: typeof readFileSync;

  constructor(options: LocalSemanticOptions = {}) {
    this.#home = options.home ?? join(homedir(), ".vibebloat");
    this.#readFile = options.readFile ?? readFileSync;
  }

  async probe(query: Pick<Required<SemanticQuery>, "repoRoot" | "timeoutMs">, signal: AbortSignal): Promise<SemanticProbeResult> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const root = canonicalRoot(query.repoRoot);
      return {
        available: true,
        repoReady: statSync(root).isDirectory(),
        readCapabilities: [...supportedIntents],
        reason: "ready",
      };
    } catch {
      return { available: true, repoReady: false, readCapabilities: [...supportedIntents], reason: "repo-unavailable" };
    }
  }

  rebuild(repoRoot: string, signal: AbortSignal = new AbortController().signal): void {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const root = canonicalRoot(repoRoot);
    const files = indexableFiles(root);
    const database = openDatabase(localSemanticIndexPath(root, this.#home));
    const currentPaths = new Set(files.map((file) => file.path));
    const listFiles = database.prepare("SELECT path, size, mtime_ms FROM files");
    const existingFiles = listFiles.all() as Array<{ path: string; size: number; mtime_ms: number }>;
    listFiles.finalize();
    const byPath = new Map(existingFiles.map((file) => [file.path, file]));
    const removeFile = database.prepare("DELETE FROM files WHERE path = ?");
    const upsertFile = database.prepare("INSERT INTO files(path, size, mtime_ms) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms");
    const insertChunk = database.prepare("INSERT INTO chunks(path, start_line, end_line, excerpt) VALUES (?, ?, ?, ?)");
    const insertPosting = database.prepare("INSERT INTO postings(token, chunk_id, frequency) VALUES (?, ?, ?)");

    const update = database.transaction(() => {
      for (const existing of existingFiles) {
        if (!currentPaths.has(existing.path)) removeFile.run(existing.path);
      }
      for (const file of files) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (!changed(byPath.get(file.path) ?? null, file)) continue;
        const text = decodeText(this.#readFile(file.absolutePath));
        removeFile.run(file.path);
        if (text === undefined) continue;
        upsertFile.run(file.path, file.size, file.mtimeMs);
        const lines = text.split(/\r?\n/);
        for (let offset = 0; offset < lines.length; offset += chunkLines) {
          const excerpt = lines.slice(offset, offset + chunkLines).join("\n");
          if (!excerpt.trim()) continue;
          const inserted = insertChunk.run(file.path, offset + 1, Math.min(lines.length, offset + chunkLines), excerpt);
          const chunkId = Number(inserted.lastInsertRowid);
          for (const [token, frequency] of tokenFrequencies(excerpt, file.path)) {
            insertPosting.run(token, chunkId, frequency);
          }
        }
      }
    });

    try {
      update.immediate();
    } finally {
      removeFile.finalize();
      upsertFile.finalize();
      insertChunk.finalize();
      insertPosting.finalize();
      database.close(true);
    }
  }

  async retrieve(query: Required<SemanticQuery>, signal: AbortSignal): Promise<{ hits: SemanticHit[] }> {
    this.rebuild(query.repoRoot, signal);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const root = canonicalRoot(query.repoRoot);
    const database = openDatabase(localSemanticIndexPath(root, this.#home));
    try {
      const queryTokenList = [...new Set(tokens(query.redactedQuery))].slice(0, 32);
      if (queryTokenList.length === 0 && query.touchedPaths.length === 0) return { hits: [] };
      const placeholders = queryTokenList.map(() => "?").join(", ");
      const statement = queryTokenList.length > 0
        ? database.prepare(`
            SELECT c.path, c.start_line, c.end_line, c.excerpt, SUM(p.frequency) AS term_score
            FROM postings p JOIN chunks c ON c.id = p.chunk_id
            WHERE p.token IN (${placeholders})
            GROUP BY c.id
            ORDER BY term_score DESC
            LIMIT 256
          `)
        : database.prepare(`
            SELECT path, start_line, end_line, excerpt, 0 AS term_score
            FROM chunks
            WHERE path IN (${query.touchedPaths.map(() => "?").join(", ")})
            LIMIT 256
          `);
      const rows = statement.all(...(queryTokenList.length > 0 ? queryTokenList : query.touchedPaths.map(normalizeRelativePath))) as Array<{ path: string; start_line: number; end_line: number; excerpt: string; term_score: number }>;
      statement.finalize();
      if (queryTokenList.length > 0 && query.touchedPaths.length > 0) {
        const touchedStatement = database.prepare(`
          SELECT path, start_line, end_line, excerpt, 0 AS term_score
          FROM chunks
          WHERE path IN (${query.touchedPaths.map(() => "?").join(", ")})
          LIMIT 256
        `);
        const touchedRows = touchedStatement.all(...query.touchedPaths.map(normalizeRelativePath)) as typeof rows;
        touchedStatement.finalize();
        const seen = new Set(rows.map((row) => `${row.path}:${row.start_line}`));
        for (const row of touchedRows) {
          if (!seen.has(`${row.path}:${row.start_line}`)) rows.push(row);
        }
      }
      const queryTokenSet = new Set(queryTokenList);
      const ranked: StoredChunk[] = rows.map((row) => {
        const symbols = declaredSymbols(row.excerpt);
        return {
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          symbol: symbols[0],
          excerpt: row.excerpt,
          termScore: touchedScore(row.path, query.touchedPaths)
            + pathTokenScore(row.path, queryTokenSet)
            + symbolTokenScore(symbols, queryTokenSet)
            + Math.min(128, row.term_score) * 10,
        };
      });
      ranked.sort((left, right) => right.termScore - left.termScore || left.path.localeCompare(right.path) || left.startLine - right.startLine);
      return {
        hits: ranked.slice(0, query.limit).map(({ termScore, ...hit }) => ({ ...hit, score: termScore })),
      };
    } finally {
      database.close(true);
    }
  }
}

export function createLocalSemanticAdapter(options: LocalSemanticOptions = {}): LocalSemanticAdapter {
  return new LocalSemanticAdapter(options);
}
