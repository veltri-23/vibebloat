import { existsSync } from "node:fs";
import { dirname } from "node:path";
import type {
  RetrievalIntent,
  SemanticAdapter,
  SemanticHit,
  SemanticProbeResult,
  SemanticQuery,
} from "./semantic";

const capabilities: RetrievalIntent[] = ["related-code", "symbol", "references", "architecture"];
const maximumOutputBytes = 1_048_576;
const successfulProbeTtlMs = 60_000;
const failedProbeTtlMs = 10_000;
const allowedTools = new Set([
  "get_architecture",
  "get_code_snippet",
  "list_projects",
  "search_code",
  "search_graph",
  "trace_path",
]);

export interface CodebaseMemoryProcessRequest {
  executable: string;
  args: string[];
  stdin?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface CodebaseMemoryProcessResult {
  exitCode: number;
  stdout: string;
}

export type CodebaseMemoryExecutor = (
  request: CodebaseMemoryProcessRequest,
) => Promise<CodebaseMemoryProcessResult>;

export interface CodebaseMemorySemanticOptions {
  executable?: string;
  executor?: CodebaseMemoryExecutor;
  env?: Record<string, string | undefined>;
  pathExists?: (path: string) => boolean;
  now?: () => number;
}

interface ProjectRegistration {
  name: string;
  root: string;
  nodes: number;
}

interface CachedProbe {
  expiresAt: number;
  projectName?: string;
  result: SemanticProbeResult;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumOutputBytes) {
        onLimit();
        throw new Error("backend-output-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export const executeCodebaseMemory: CodebaseMemoryExecutor = async (request) => {
  if (request.signal.aborted) throw abortError();
  const child = Bun.spawn({
    cmd: [request.executable, ...request.args],
    stdin: request.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  if (request.stdin !== undefined) {
    child.stdin.write(request.stdin);
    child.stdin.end();
  }

  let timedOut = false;
  const kill = () => {
    try {
      child.kill();
    } catch {
      return;
    }
  };
  const onAbort = () => kill();
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, request.timeoutMs + 25);

  try {
    const stdoutPromise = readBoundedOutput(child.stdout, kill);
    const exitCode = await child.exited;
    const stdout = await stdoutPromise;
    if (request.signal.aborted) throw abortError();
    if (timedOut) throw new DOMException("Timed out", "TimeoutError");
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
  }
};

export function discoverCodebaseMemoryExecutable(
  options: Pick<CodebaseMemorySemanticOptions, "env" | "pathExists"> = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.CODEBASE_MEMORY_MCP_PATH?.trim();
  if (explicit) return explicit;
  const pathExists = options.pathExists ?? existsSync;
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const known = `${localAppData.replace(/[\\/]+$/, "")}\\Programs\\codebase-memory-mcp\\codebase-memory-mcp.exe`;
      if (pathExists(known)) return known;
    }
  }
  return process.platform === "win32" ? "codebase-memory-mcp.exe" : "codebase-memory-mcp";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portablePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function comparableRoot(path: string): string {
  const normalized = portablePath(path);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function safeRelativePath(path: unknown, repoRoot: string): string | undefined {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return undefined;
  const normalized = portablePath(path).replace(/^\.\//, "");
  const root = portablePath(repoRoot);
  const comparablePath = comparableRoot(normalized);
  const comparableRepo = comparableRoot(root);
  let relativePath = normalized;
  if (/^(?:[A-Za-z]:\/|\/|\/\/)/.test(normalized)) {
    if (comparablePath === comparableRepo) return ".";
    if (!comparablePath.startsWith(`${comparableRepo}/`)) return undefined;
    relativePath = normalized.slice(root.length + 1);
  }
  if (!relativePath || /^(?:[A-Za-z]:|\/)/.test(relativePath)) return undefined;
  if (relativePath.split("/").some((part) => part === ".." || part === "")) return undefined;
  return relativePath;
}

function scrubAbsolutePaths(value: string, repoRoot: string): string {
  const roots = [portablePath(repoRoot), portablePath(repoRoot).replaceAll("/", "\\")]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let scrubbed = value;
  for (const root of roots) scrubbed = scrubbed.replaceAll(root, "<repo>");
  return scrubbed
    .replace(/[A-Za-z]:[\\/](?:[^\s"'`]+[\\/]?)+/g, "<absolute-path>")
    .replace(/\\\\[^\s"'`]+\\[^\s"'`]+(?:\\[^\s"'`]+)*/g, "<absolute-path>")
    .replace(/\/(?:Users|home|root|private|tmp|var|etc|opt|mnt|srv)\/(?:[^\s"'`]+\/?)+/g, "<absolute-path>");
}

function safeText(value: unknown, repoRoot: string, maximum = 8_192): string | undefined {
  if (typeof value !== "string") return undefined;
  return scrubAbsolutePaths(value.replaceAll("\r", ""), repoRoot).slice(0, maximum);
}

function positiveLine(value: unknown, fallback = 1): number {
  return Number.isInteger(value) && (value as number) >= 1 ? value as number : fallback;
}

function projectRegistrations(value: unknown): ProjectRegistration[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.projects)) return undefined;
  const registrations: ProjectRegistration[] = [];
  for (const project of value.projects) {
    if (!isRecord(project) || typeof project.name !== "string" || typeof project.root_path !== "string") return undefined;
    if (!Number.isInteger(project.nodes) || (project.nodes as number) < 0) return undefined;
    registrations.push({ name: project.name, root: project.root_path, nodes: project.nodes as number });
  }
  return registrations;
}

function resultArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.results) || !value.results.every(isRecord)) return undefined;
  return value.results;
}

function graphHits(value: unknown, repoRoot: string): SemanticHit[] | undefined {
  const results = resultArray(value);
  if (!results) return undefined;
  const hits: SemanticHit[] = [];
  for (const result of results) {
    const path = safeRelativePath(result.file_path, repoRoot);
    const name = safeText(result.name, repoRoot, 512);
    const signature = result.signature === undefined ? "" : safeText(result.signature, repoRoot, 2_048);
    if (!path || name === undefined || signature === undefined) return undefined;
    const startLine = positiveLine(result.start_line);
    hits.push({
      path,
      startLine,
      endLine: positiveLine(result.end_line, startLine),
      symbol: name,
      excerpt: `${name}${signature}`,
    });
  }
  return hits;
}

function codeHits(value: unknown, repoRoot: string): SemanticHit[] | undefined {
  const results = resultArray(value);
  if (!results) return undefined;
  const hits: SemanticHit[] = [];
  for (const result of results) {
    const path = safeRelativePath(result.file ?? result.file_path, repoRoot);
    const excerpt = safeText(result.context ?? result.source, repoRoot);
    const symbol = result.node === undefined ? undefined : safeText(result.node, repoRoot, 512);
    if (!path || excerpt === undefined || symbol === undefined && result.node !== undefined) return undefined;
    const startLine = positiveLine(result.context_start ?? result.start_line);
    const excerptLines = Math.max(1, excerpt.split("\n").length);
    hits.push({
      path,
      startLine,
      endLine: positiveLine(result.end_line, startLine + excerptLines - 1),
      ...(symbol ? { symbol } : {}),
      excerpt,
    });
  }
  return hits;
}

function snippetHit(value: unknown, repoRoot: string): SemanticHit | undefined {
  if (!isRecord(value)) return undefined;
  const path = safeRelativePath(value.file_path, repoRoot);
  const excerpt = safeText(value.source, repoRoot);
  const symbol = safeText(value.name, repoRoot, 512);
  if (!path || excerpt === undefined || symbol === undefined) return undefined;
  const startLine = positiveLine(value.start_line);
  return {
    path,
    startLine,
    endLine: positiveLine(value.end_line, startLine),
    symbol,
    excerpt,
  };
}

function uniqueHits(hits: readonly SemanticHit[], limit: number): SemanticHit[] {
  const seen = new Set<string>();
  const result: SemanticHit[] = [];
  for (const hit of hits) {
    const key = `${hit.path}:${hit.startLine}:${hit.endLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit);
    if (result.length >= limit) break;
  }
  return result;
}

function traceHits(value: unknown, query: Required<SemanticQuery>): SemanticHit[] | undefined {
  if (!isRecord(value)) return undefined;
  const groups = [value.callers, value.callees].filter((group) => group !== undefined);
  if (groups.some((group) => !Array.isArray(group) || !group.every(isRecord))) return undefined;
  const entries = groups.flat() as Record<string, unknown>[];
  const names: string[] = [];
  for (const entry of entries) {
    const name = safeText(entry.qualified_name ?? entry.name, query.repoRoot, 1_024);
    if (name === undefined) return undefined;
    names.push(name);
  }
  if (names.length === 0) return [];
  const touchedPath = query.touchedPaths[0]
    ? safeRelativePath(query.touchedPaths[0], query.repoRoot)
    : undefined;
  return [{
    path: touchedPath ?? ".",
    startLine: 1,
    endLine: 1,
    excerpt: `References: ${names.slice(0, query.limit).join(", ")}`,
  }];
}

function architectureHits(value: unknown, query: Required<SemanticQuery>, projectName: string): SemanticHit[] | undefined {
  if (!isRecord(value) || value.project !== projectName) return undefined;
  if (!Number.isInteger(value.total_nodes) || (value.total_nodes as number) < 0) return undefined;
  if (!Number.isInteger(value.total_edges) || (value.total_edges as number) < 0) return undefined;
  const packages = Array.isArray(value.packages) ? value.packages : [];
  if (!packages.every(isRecord)) return undefined;
  const summaries: string[] = [];
  for (const entry of packages.slice(0, query.limit)) {
    const name = safeText(entry.name, query.repoRoot, 256);
    if (name === undefined || !Number.isInteger(entry.node_count)) return undefined;
    summaries.push(`${name} (${entry.node_count})`);
  }
  const scope = architectureScope(query.touchedPaths, query.repoRoot) ?? ".";
  return [{
    path: scope,
    startLine: 1,
    endLine: 1,
    excerpt: `Nodes: ${value.total_nodes}. Edges: ${value.total_edges}.${summaries.length ? ` Packages: ${summaries.join(", ")}.` : ""}`,
  }];
}

function architectureScope(touchedPaths: readonly string[], repoRoot: string): string | undefined {
  const first = touchedPaths[0];
  if (!first) return undefined;
  const safePath = safeRelativePath(first, repoRoot);
  if (!safePath || safePath === ".") return undefined;
  const directory = dirname(safePath).replaceAll("\\", "/");
  return directory === "." ? undefined : directory;
}

export class CodebaseMemorySemanticAdapter implements SemanticAdapter {
  readonly id = "codebase-memory" as const;
  readonly #executable: string;
  readonly #executor: CodebaseMemoryExecutor;
  readonly #now: () => number;
  readonly #probeCache = new Map<string, CachedProbe>();

  constructor(options: CodebaseMemorySemanticOptions = {}) {
    this.#executable = options.executable ?? discoverCodebaseMemoryExecutable(options);
    this.#executor = options.executor ?? executeCodebaseMemory;
    this.#now = options.now ?? Date.now;
  }

  async #invoke(tool: string, args: string[], signal: AbortSignal, timeoutMs: number): Promise<unknown> {
    if (!allowedTools.has(tool)) throw new Error("forbidden-backend-tool");
    const result = await this.#executor({
      executable: this.#executable,
      args: ["cli", tool, ...args],
      signal,
      timeoutMs,
    });
    if (result.exitCode !== 0) throw new Error("backend-command-failed");
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new Error("backend-response-invalid");
    }
  }

  async #registration(repoRoot: string, signal: AbortSignal, timeoutMs: number): Promise<CachedProbe> {
    const key = comparableRoot(repoRoot);
    const cached = this.#probeCache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached;
    let result: SemanticProbeResult;
    let projectName: string | undefined;
    try {
      const registrations = projectRegistrations(await this.#invoke("list_projects", [], signal, timeoutMs));
      if (!registrations) {
        result = { available: true, repoReady: false, readCapabilities: [], reason: "response-invalid" };
      } else {
        const exact = registrations.find((project) => comparableRoot(project.root) === key);
        if (!exact) {
          result = { available: true, repoReady: false, readCapabilities: [...capabilities], reason: "repo-not-registered" };
        } else if (exact.nodes === 0) {
          result = { available: true, repoReady: false, readCapabilities: [...capabilities], reason: "repo-empty" };
        } else {
          projectName = exact.name;
          result = { available: true, repoReady: true, readCapabilities: [...capabilities], reason: "ready" };
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      result = { available: false, repoReady: false, readCapabilities: [], reason: "cli-unavailable" };
    }
    const entry = {
      expiresAt: this.#now() + (result.available && result.repoReady ? successfulProbeTtlMs : failedProbeTtlMs),
      projectName,
      result,
    };
    this.#probeCache.set(key, entry);
    return entry;
  }

  async probe(query: Pick<Required<SemanticQuery>, "repoRoot" | "timeoutMs">, signal: AbortSignal): Promise<SemanticProbeResult> {
    return (await this.#registration(query.repoRoot, signal, query.timeoutMs)).result;
  }

  async retrieve(query: Required<SemanticQuery>, signal: AbortSignal): Promise<{ hits: SemanticHit[] }> {
    const registration = await this.#registration(query.repoRoot, signal, query.timeoutMs);
    if (!registration.result.repoReady || !registration.projectName) return { hits: [] };
    const project = registration.projectName;
    const commonArgs = ["--project", project];

    if (query.intent === "related-code") {
      const graph = await this.#invoke("search_graph", [
        ...commonArgs,
        "--query", query.redactedQuery,
        "--limit", String(query.limit),
      ], signal, query.timeoutMs);
      const normalizedGraph = graphHits(graph, query.repoRoot);
      if (!normalizedGraph) return { hits: [] };
      const code = await this.#invoke("search_code", [
        ...commonArgs,
        "--pattern", query.redactedQuery,
        "--mode", "compact",
        "--context", "3",
        "--regex", "false",
        "--limit", String(query.limit),
      ], signal, query.timeoutMs);
      const normalizedCode = codeHits(code, query.repoRoot);
      return { hits: normalizedCode ? uniqueHits([...normalizedCode, ...normalizedGraph], query.limit) : [] };
    }

    if (query.intent === "symbol") {
      const graph = await this.#invoke("search_graph", [
        ...commonArgs,
        "--query", query.redactedQuery,
        "--limit", String(query.limit),
      ], signal, query.timeoutMs);
      const results = resultArray(graph);
      const normalizedGraph = graphHits(graph, query.repoRoot);
      if (!results || !normalizedGraph) return { hits: [] };
      const hits: SemanticHit[] = [];
      for (const result of results.slice(0, query.limit)) {
        if (typeof result.qualified_name !== "string") return { hits: [] };
        const snippet = await this.#invoke("get_code_snippet", [
          ...commonArgs,
          "--qualified-name", result.qualified_name,
          "--include-neighbors", "false",
        ], signal, query.timeoutMs);
        const hit = snippetHit(snippet, query.repoRoot);
        if (!hit) return { hits: [] };
        hits.push(hit);
      }
      return { hits: uniqueHits(hits.length ? hits : normalizedGraph, query.limit) };
    }

    if (query.intent === "references") {
      const trace = await this.#invoke("trace_path", [
        ...commonArgs,
        "--function-name", query.redactedQuery,
        "--direction", "both",
        "--depth", "2",
        "--mode", "calls",
        "--include-tests", "false",
      ], signal, query.timeoutMs);
      return { hits: traceHits(trace, query) ?? [] };
    }

    const scope = architectureScope(query.touchedPaths, query.repoRoot);
    const architecture = await this.#invoke("get_architecture", [
      ...commonArgs,
      ...(scope ? ["--path", scope] : []),
      "--aspects", "overview",
    ], signal, query.timeoutMs);
    return { hits: architectureHits(architecture, query, project) ?? [] };
  }
}

export function createCodebaseMemorySemanticAdapter(
  options: CodebaseMemorySemanticOptions = {},
): CodebaseMemorySemanticAdapter {
  return new CodebaseMemorySemanticAdapter(options);
}
