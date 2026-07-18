import { isAbsolute } from "node:path";

export interface RetrievalResult {
  source: "codebase-memory" | "local";
  results: string[];
}

export type RetrievalIntent = "related-code" | "symbol" | "references" | "architecture";
export type SemanticBackendId = "codebase-memory" | "local" | "gbrain" | "serena" | "codegraph-context";
export type SemanticDiagnosticCode = "backend-unavailable" | "backend-error" | "backend-timeout" | "backend-invalid" | "backend-empty" | "results-truncated";

export interface SemanticQuery {
  repoRoot: string;
  redactedQuery: string;
  touchedPaths: string[];
  intent: RetrievalIntent;
  limit?: number;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface SemanticHit {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  excerpt: string;
  score?: number;
}

export interface SemanticProbeResult {
  available: boolean;
  repoReady: boolean;
  readCapabilities: RetrievalIntent[];
  reason: string;
}

export interface SemanticAdapter {
  readonly id: SemanticBackendId;
  probe(query: Pick<Required<SemanticQuery>, "repoRoot" | "timeoutMs">, signal: AbortSignal): Promise<unknown>;
  retrieve(query: Required<SemanticQuery>, signal: AbortSignal): Promise<unknown>;
}

export interface SemanticCoordinatorOptions {
  primary: SemanticAdapter;
  local: SemanticAdapter;
  experimental?: readonly SemanticAdapter[];
  enableExperimental?: boolean;
}

export interface SemanticRetrievalResult {
  backend: SemanticBackendId;
  status: "ok" | "empty" | "degraded";
  hits: SemanticHit[];
  diagnostics: string[];
}

type OperationOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "error" }
  | { status: "timeout" };

const maximumHits = 8;
const maximumLinesPerHit = 40;
const maximumBytes = 24_576;
const maximumTimeoutMs = 2_000;

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function normalizedQuery(query: SemanticQuery): Required<SemanticQuery> {
  return {
    ...query,
    touchedPaths: [...query.touchedPaths],
    limit: boundedInteger(query.limit, maximumHits, 1, maximumHits),
    maxBytes: boundedInteger(query.maxBytes, maximumBytes, 1, maximumBytes),
    timeoutMs: boundedInteger(query.timeoutMs, maximumTimeoutMs, 1, maximumTimeoutMs),
  };
}

function diagnostic(adapter: SemanticAdapter, code: SemanticDiagnosticCode): string {
  return `${adapter.id}:${code}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetrievalIntent(value: unknown): value is RetrievalIntent {
  return value === "related-code" || value === "symbol" || value === "references" || value === "architecture";
}

function isProbeResult(value: unknown): value is SemanticProbeResult {
  if (!isRecord(value)) return false;
  return typeof value.available === "boolean"
    && typeof value.repoReady === "boolean"
    && typeof value.reason === "string"
    && Array.isArray(value.readCapabilities)
    && value.readCapabilities.every(isRetrievalIntent);
}

function isAbsolutePortablePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolutePortablePath(path) && !path.split(/[\\/]/).includes("..");
}

function isValidQuery(value: unknown): value is SemanticQuery {
  if (!isRecord(value)) return false;
  return typeof value.repoRoot === "string"
    && isAbsolutePortablePath(value.repoRoot)
    && typeof value.redactedQuery === "string"
    && value.redactedQuery.trim().length > 0
    && Array.isArray(value.touchedPaths)
    && value.touchedPaths.every((path) => typeof path === "string" && isSafeRelativePath(path))
    && isRetrievalIntent(value.intent);
}

function isHit(value: unknown): value is SemanticHit {
  if (!isRecord(value)) return false;
  return typeof value.path === "string"
    && isSafeRelativePath(value.path)
    && Number.isInteger(value.startLine)
    && (value.startLine as number) >= 1
    && Number.isInteger(value.endLine)
    && (value.endLine as number) >= (value.startLine as number)
    && typeof value.excerpt === "string"
    && (value.symbol === undefined || typeof value.symbol === "string")
    && (value.score === undefined || (typeof value.score === "number" && Number.isFinite(value.score)));
}

function parsedHits(value: unknown): SemanticHit[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.hits) || !value.hits.every(isHit)) return undefined;
  return value.hits;
}

function truncateUtf8(value: string, byteLimit: number): string {
  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (usedBytes + characterBytes > byteLimit) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}

function serializedHitsBytes(hits: readonly SemanticHit[]): number {
  return Buffer.byteLength(JSON.stringify(hits));
}

function cappedHits(hits: readonly SemanticHit[], limit: number, byteLimit: number): { hits: SemanticHit[]; truncated: boolean } {
  const result: SemanticHit[] = [];
  const seen = new Set<string>();
  let truncated = hits.length > limit;

  for (const hit of hits) {
    if (result.length >= limit || serializedHitsBytes(result) >= byteLimit) {
      truncated = true;
      break;
    }
    const key = `${hit.path}:${hit.startLine}:${hit.endLine}`;
    if (seen.has(key)) {
      truncated = true;
      continue;
    }
    seen.add(key);

    const lines = hit.excerpt.split(/\r?\n/);
    const lineBounded = lines.slice(0, maximumLinesPerHit).join("\n");
    const candidate = {
      ...hit,
      endLine: Math.min(hit.endLine, hit.startLine + Math.max(1, lines.slice(0, maximumLinesPerHit).length) - 1),
      excerpt: lineBounded,
    };
    const metadataBytes = serializedHitsBytes([...result, { ...candidate, excerpt: "" }]);
    if (metadataBytes > byteLimit) {
      truncated = true;
      continue;
    }
    candidate.excerpt = truncateUtf8(candidate.excerpt, byteLimit - metadataBytes);
    while (candidate.excerpt.length > 0 && serializedHitsBytes([...result, candidate]) > byteLimit) {
      const excessBytes = serializedHitsBytes([...result, candidate]) - byteLimit;
      const next = truncateUtf8(candidate.excerpt, Math.max(0, Buffer.byteLength(candidate.excerpt) - excessBytes));
      candidate.excerpt = next === candidate.excerpt ? [...candidate.excerpt].slice(0, -1).join("") : next;
    }
    if (lines.length > maximumLinesPerHit || candidate.excerpt !== lineBounded) truncated = true;
    if (candidate.excerpt.length === 0 && hit.excerpt.length > 0) {
      truncated = true;
      continue;
    }
    const lineCount = Math.max(1, candidate.excerpt.split("\n").length);
    candidate.endLine = Math.min(candidate.endLine, candidate.startLine + lineCount - 1);
    result.push(candidate);
  }

  return { hits: result, truncated };
}

async function runBounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<OperationOutcome<T>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operationResult = Promise.resolve()
    .then(() => operation(controller.signal))
    .then<OperationOutcome<T>>(
      (value) => ({ status: "ok", value }),
      () => ({ status: "error" }),
    );
  const timeoutResult = new Promise<OperationOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ status: "timeout" });
    }, timeoutMs);
  });
  const result = await Promise.race([operationResult, timeoutResult]);
  if (timer) clearTimeout(timer);
  return result;
}

export async function retrieveSemanticContext(query: SemanticQuery, options: SemanticCoordinatorOptions): Promise<SemanticRetrievalResult> {
  if (!isValidQuery(query)) {
    return {
      backend: options.local.id,
      status: "degraded",
      hits: [],
      diagnostics: ["coordinator:query-invalid"],
    };
  }
  const boundedQuery = normalizedQuery(query);
  const diagnostics: string[] = [];
  const adapters = [
    options.primary,
    ...(options.enableExperimental ? options.experimental ?? [] : []),
    options.local,
  ];
  let localWasEmpty = false;

  for (const adapter of adapters) {
    const probe = await runBounded(
      (signal) => adapter.probe({ repoRoot: boundedQuery.repoRoot, timeoutMs: boundedQuery.timeoutMs }, signal),
      Math.min(500, boundedQuery.timeoutMs),
    );
    if (probe.status === "timeout") {
      diagnostics.push(diagnostic(adapter, "backend-timeout"));
      continue;
    }
    if (probe.status === "error") {
      diagnostics.push(diagnostic(adapter, "backend-error"));
      continue;
    }
    if (!isProbeResult(probe.value)) {
      diagnostics.push(diagnostic(adapter, "backend-invalid"));
      continue;
    }
    if (!probe.value.available || !probe.value.repoReady || !probe.value.readCapabilities.includes(boundedQuery.intent)) {
      diagnostics.push(diagnostic(adapter, "backend-unavailable"));
      continue;
    }

    const retrieval = await runBounded((signal) => adapter.retrieve(boundedQuery, signal), boundedQuery.timeoutMs);
    if (retrieval.status === "timeout") {
      diagnostics.push(diagnostic(adapter, "backend-timeout"));
      continue;
    }
    if (retrieval.status === "error") {
      diagnostics.push(diagnostic(adapter, "backend-error"));
      continue;
    }
    const hits = parsedHits(retrieval.value);
    if (!hits) {
      diagnostics.push(diagnostic(adapter, "backend-invalid"));
      continue;
    }
    if (hits.length === 0) {
      diagnostics.push(diagnostic(adapter, "backend-empty"));
      if (adapter === options.local) localWasEmpty = true;
      continue;
    }

    const capped = cappedHits(hits, boundedQuery.limit, boundedQuery.maxBytes);
    if (capped.truncated) diagnostics.push(diagnostic(adapter, "results-truncated"));
    if (capped.hits.length === 0) {
      diagnostics.push(diagnostic(adapter, "backend-empty"));
      if (adapter === options.local) localWasEmpty = true;
      continue;
    }
    return { backend: adapter.id, status: "ok", hits: capped.hits, diagnostics };
  }

  return {
    backend: options.local.id,
    status: localWasEmpty ? "empty" : "degraded",
    hits: [],
    diagnostics,
  };
}

export async function retrieveContext(query: string, queryGraph: (query: string) => Promise<string[]>, queryLocal: (query: string) => Promise<string[]>): Promise<RetrievalResult> {
  try {
    return { source: "codebase-memory", results: await queryGraph(query) };
  } catch {
    return { source: "local", results: await queryLocal(query) };
  }
}
