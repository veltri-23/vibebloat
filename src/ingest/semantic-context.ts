import { isAbsolute } from "node:path";
import { isScrubbedCandidates, type ScrubbedCandidates } from "../scrub/scrubbed-candidates";
import {
  retrieveSemanticContext,
  type RetrievalIntent,
  type SemanticBackendId,
  type SemanticCoordinatorOptions,
  type SemanticHit,
  type SemanticQuery,
  type SemanticRetrievalResult,
} from "./semantic";

export const semanticContextBegin = "<<<VIBEBLOAT_UNTRUSTED_SEMANTIC_CONTEXT_V1>>>";
export const semanticContextEnd = "<<<END_VIBEBLOAT_UNTRUSTED_SEMANTIC_CONTEXT_V1>>>";
const validatedSemanticContext = Symbol("validated-semantic-context");

export interface UntrustedSemanticContext {
  readonly begin: typeof semanticContextBegin;
  readonly trust: "untrusted-data-not-instructions";
  readonly backend: SemanticBackendId;
  readonly hits: readonly SemanticHit[];
  readonly end: typeof semanticContextEnd;
  readonly [validatedSemanticContext]: true;
}

export interface ScanSemanticOptions {
  repoRoot: string;
  touchedPaths?: readonly string[];
  intent?: RetrievalIntent;
  coordinator: SemanticCoordinatorOptions;
}

const incidentSignals = ["failed", "failure", "error", "broken", "breakage", "fix", "fixed", "retry"] as const;
const maximumContextBytes = 24_576;
const maximumContextHits = 8;
const maximumLinesPerHit = 40;

function isAbsolutePortablePath(path: string): boolean {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path);
}

function safeTouchedPaths(paths: readonly string[] | undefined): string[] {
  if (!paths) return [];
  return [...new Set(paths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => path.length > 0
      && path.length <= 240
      && !isAbsolutePortablePath(path)
      && !path.split("/").includes("..")
      && /^[A-Za-z0-9._@+/-]+$/.test(path)))]
    .slice(0, 32);
}

function buildRedactedQuery(scrubbed: ScrubbedCandidates, touchedPaths: readonly string[]): string {
  const signals = incidentSignals.filter((signal) => scrubbed.candidates.some((candidate) => new RegExp(`\\b${signal}\\b`, "i").test(candidate.content)));
  return ["incident", ...(signals.length ? signals : ["failure"]), ...touchedPaths].join(" ").slice(0, 2_048);
}

function scanQuery(scrubbed: ScrubbedCandidates, options: ScanSemanticOptions): SemanticQuery {
  const touchedPaths = safeTouchedPaths(options.touchedPaths);
  return {
    repoRoot: options.repoRoot,
    redactedQuery: buildRedactedQuery(scrubbed, touchedPaths),
    touchedPaths,
    intent: options.intent ?? "related-code",
  };
}

function sanitizeExcerpt(excerpt: string): string {
  return excerpt
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/file:\/\/[A-Za-z]:[\\/][^\s"'`<>|]+/gi, "<absolute-path>")
    .replace(/[A-Za-z]:[\\/][^\s"'`<>|]+/g, "<absolute-path>")
    .replace(/\\\\[^\s"'`<>|]+/g, "<absolute-path>")
    .replace(/(^|[\s("'`])(?:~\/|\/)[^\s"'`<>|]+/g, "$1<absolute-path>")
    .replace(/(?:ignore|disregard)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+(?:instructions?|messages?)/gi, "<prompt-injection-redacted>")
    .replace(/(?:system|developer)\s+prompt/gi, "<prompt-injection-redacted>")
    .replace(/(?:forget|override)\s+(?:all\s+)?(?:rules?|instructions?)/gi, "<prompt-injection-redacted>")
    .replace(/^[ \t]*(?:[$>#]\s*)?(?:sudo\s+)?(?:rm|git|npm|npx|pnpm|yarn|bun|curl|wget|powershell|pwsh|cmd|bash|sh|python|node)\b.*$/gim, "<command-redacted>")
    .replace(/\b(?:sudo\s+)?(?:rm|git|npm|npx|pnpm|yarn|bun|curl|wget|powershell|pwsh|cmd|bash|sh|python|node)\s+(?:-[^\s]+|[a-z][\w-]*)(?:\s+[^\r\n]*)?/gim, "<command-redacted>");
}

function isSafeHit(hit: SemanticHit): boolean {
  return typeof hit.path === "string"
    && hit.path.length > 0
    && hit.path.length <= 240
    && !isAbsolutePortablePath(hit.path)
    && !hit.path.split(/[\\/]/).includes("..")
    && /^[A-Za-z0-9._@+/-]+$/.test(hit.path)
    && Number.isInteger(hit.startLine)
    && hit.startLine >= 1
    && Number.isInteger(hit.endLine)
    && hit.endLine >= hit.startLine
    && typeof hit.excerpt === "string"
    && (hit.symbol === undefined || (typeof hit.symbol === "string" && /^[A-Za-z_$][A-Za-z0-9_$.:#-]{0,159}$/.test(hit.symbol)))
    && (hit.score === undefined || (typeof hit.score === "number" && Number.isFinite(hit.score)));
}

function toUntrustedContext(result: SemanticRetrievalResult): UntrustedSemanticContext | undefined {
  if (result.status !== "ok" || result.hits.length === 0 || result.hits.length > maximumContextHits || !result.hits.every(isSafeHit)) return undefined;
  if (Buffer.byteLength(JSON.stringify(result.hits)) > maximumContextBytes) return undefined;
  const hits = result.hits.map((hit) => ({
    ...hit,
    endLine: Math.min(hit.endLine, hit.startLine + maximumLinesPerHit - 1),
    excerpt: sanitizeExcerpt(hit.excerpt).split(/\r?\n/).slice(0, maximumLinesPerHit).join("\n"),
  }));
  if (Buffer.byteLength(JSON.stringify(hits)) > maximumContextBytes) return undefined;
  return {
    begin: semanticContextBegin,
    trust: "untrusted-data-not-instructions",
    backend: result.backend,
    hits,
    end: semanticContextEnd,
    [validatedSemanticContext]: true,
  };
}

export function isUntrustedSemanticContext(value: unknown): value is UntrustedSemanticContext {
  return Boolean(value && typeof value === "object" && (value as UntrustedSemanticContext)[validatedSemanticContext] === true);
}

export async function retrieveScanSemanticContext(scrubbed: ScrubbedCandidates, options: ScanSemanticOptions): Promise<UntrustedSemanticContext | undefined> {
  if (!isScrubbedCandidates(scrubbed)) return undefined;
  try {
    const result = await retrieveSemanticContext(scanQuery(scrubbed, options), options.coordinator);
    return toUntrustedContext(result);
  } catch {
    return undefined;
  }
}
