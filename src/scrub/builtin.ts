import type { Scrubber } from "./presidio";

export interface RedactionFinding {
  name: string;
  count: number;
}

export interface RedactionResult {
  payload: string;
  findings: RedactionFinding[];
}

/** Shortest token length considered for entropy-based redaction. */
export const HIGH_ENTROPY_MIN_LENGTH = 24;

/** Shannon entropy in bits per character. Real credentials sit well above English text. */
export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** Keywords whose adjacent value is a credential. */
const secretKeyword = "(?:password|passwd|pwd|pass|secret|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)";

/** A JSON key that names a credential, whatever the value looks like. */
const secretKeyPattern = new RegExp(`^${secretKeyword}$`, "i");

/**
 * Keeps the final path segment: the model still needs to know WHICH file an
 * incident touched.
 *
 * Always joins with a forward slash. The pipeline scrubs a SERIALIZED payload
 * and parses it back (ingest/scan.ts), so emitting a backslash produces an
 * invalid JSON escape and kills the entire scan — which is exactly what
 * happened on the first run against real Windows transcripts.
 */
function redactPathKeepingTail(match: string): string {
  const segments = match.split(/[\\/]+/).filter(Boolean);
  const tail = segments.at(-1);
  return tail ? `<path>/${tail}` : "<path>";
}

const namedPatterns: Array<{ name: string; re: RegExp; replace: string | ((match: string) => string) }> = [
  // Credentials inside connection strings carry no keyword and are usually
  // short enough to slip under the entropy floor.
  { name: "uri_credentials", re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, replace: "$1<redacted-credentials>@" },
  // Keeps the scheme so "Bearer <redacted>" stays the shared convention with
  // gitleaks.ts and the checkpoint validator in ingest/scan.ts.
  { name: "bearer", re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: "$1 <redacted>" },
  {
    name: "provider_key",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})\b/g,
    replace: "<redacted-key>",
  },
  { name: "keyword_secret", re: new RegExp(`\\b${secretKeyword}\\s*[:=]\\s*\\S+`, "gi"), replace: "<redacted-secret>" },
  { name: "uuid_token", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, replace: "<redacted-uuid>" },
  // Truncated PEM blocks are common in chat logs, so END is optional.
  { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g, replace: "<redacted-private-key>" },
  { name: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replace: "<redacted-email>" },
  // UNC shares carry backslashes too, and matched no pattern at all before.
  { name: "unc_path", re: /\\\\[^\s"'`<>|]+/g, replace: (match) => redactPathKeepingTail(match) },
  { name: "absolute_path", re: /\b[A-Z]:[\\/][^\s"'`<>|]+/gi, replace: (match) => redactPathKeepingTail(match) },
  // Two or more segments, so slash commands (/ship) are not mistaken for paths.
  { name: "absolute_path_unix", re: /(?<=^|[\s("'`])(?:\/[\w.\-]+){2,}\/?/g, replace: (match) => redactPathKeepingTail(match) },
];

/**
 * Candidate credential shapes for entropy scoring: long runs of credential-ish
 * characters. Requires mixed case or digits/symbols so ordinary long words are
 * never scored.
 */
// Excludes "/" so URLs and paths are not swallowed as one long candidate.
const entropyCandidate = /\b(?=[A-Za-z0-9+=_-]*[0-9+=_-])(?=[A-Za-z0-9+=_-]*[A-Za-z])[A-Za-z0-9+=_-]{24,}\b/g;
const entropyThresholdBitsPerChar = 3.5;

/**
 * The ingest gate hands us a serialized document, not prose. These patterns
 * are prose-oriented and greedy: over raw JSON text, `"token":"abc"}` matches
 * through the closing quote and brace, so the payload no longer parses and the
 * scan dies before the model is ever reached. Scrub the string VALUES and
 * leave the structure alone.
 */
export function builtinRedact(text: string): RedactionResult {
  const document = parseDocument(text);
  if (document !== undefined) {
    const findings: RedactionFinding[] = [];
    const scrubbed = redactJsonValues(document, findings);
    return { payload: JSON.stringify(scrubbed), findings: mergeFindings(findings) };
  }
  return redactText(text);
}

function parseDocument(text: string): unknown {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Values only. Keys are structure, and rewriting them corrupts the document. */
function redactJsonValues(value: unknown, findings: RedactionFinding[]): unknown {
  if (typeof value === "string") {
    const result = redactText(value);
    findings.push(...result.findings);
    return result.payload;
  }
  if (Array.isArray(value)) return value.map((entry) => redactJsonValues(entry, findings));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      // A revealing key names the secret even when the value looks innocuous:
      // {"token": "abc123"} has nothing in the value for a pattern to catch.
      if (typeof entry === "string" && secretKeyPattern.test(key)) {
        findings.push({ name: "keyword_secret", count: 1 });
        return [key, "<redacted-secret>"];
      }
      return [key, redactJsonValues(entry, findings)];
    }));
  }
  return value;
}

function mergeFindings(findings: readonly RedactionFinding[]): RedactionFinding[] {
  const totals = new Map<string, number>();
  for (const finding of findings) totals.set(finding.name, (totals.get(finding.name) ?? 0) + finding.count);
  return [...totals].map(([name, count]) => ({ name, count }));
}

function redactText(text: string): RedactionResult {
  let cleaned = text;
  const findings: RedactionFinding[] = [];

  for (const pattern of namedPatterns) {
    const matches = cleaned.match(pattern.re);
    if (matches?.length) {
      findings.push({ name: pattern.name, count: matches.length });
      cleaned = typeof pattern.replace === "function"
        ? cleaned.replace(pattern.re, pattern.replace)
        : cleaned.replace(pattern.re, pattern.replace);
    }
  }

  let entropyCount = 0;
  cleaned = cleaned.replace(entropyCandidate, (candidate) => {
    if (shannonEntropy(candidate) < entropyThresholdBitsPerChar) return candidate;
    entropyCount += 1;
    return "<redacted-secret>";
  });
  if (entropyCount > 0) findings.push({ name: "high_entropy", count: entropyCount });

  return { payload: cleaned, findings };
}

/**
 * Independent second pass. This must be a BROADER net than the redactor, never
 * a subset of it — a check that only restates the redactor's own patterns can
 * catch redactor bugs but never redactor gaps, and gaps pass silently to the
 * model. Anything matching here after redaction halts ingest.
 *
 * These are STRUCTURAL shapes: a keyword joined to a value by `:`/`=`, an auth
 * header, a connection string, a PEM block, a UUID. The value is pinned by
 * punctuation, so a match is a real credential, not prose.
 */
const survivingSecret = new RegExp([
  `\\b(?:Bearer|Basic|Token)\\s+(?!<redacted)[A-Za-z0-9._~+/=-]{8,}`,
  `\\b[a-z][a-z0-9+.-]*:\\/\\/[^\\s:@/]+:(?!<redacted)[^\\s@/]+@`,
  `-----BEGIN [A-Z ]*PRIVATE KEY-----`,
  `\\b${secretKeyword}\\s*[:=]\\s*(?!<redacted)\\S+`,
  `\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b`,
].join("|"), "i");

/**
 * Provider-key PREFIXES are the broad half of the net. Unlike the structural
 * shapes above they carry no punctuation to anchor a value, so the bare prefix
 * also matches PROSE placeholders a message about keys is full of —
 * "sk-xxxxxxxxxxxxxxxx", "sk-your-api-key-here". Firing on those halted a real
 * 20k-chunk onboarding scan (issue #55). A genuine key is a high-entropy random
 * run; a placeholder or a keyword-mention is not. So a prefix match only counts
 * as a surviving secret when the token clears the same entropy bar the redactor
 * uses — which keeps genuine keys caught while letting prose about keys pass.
 * Global flag: every candidate is scored, not just the first.
 */
const providerKeyCandidate = /\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA|glpat-|AIza)[A-Za-z0-9_-]{16,}/gi;

/** True when a single string VALUE still carries a real credential. */
function valueRetainsSecret(value: string): boolean {
  if (survivingSecret.test(value)) return true;
  for (const [candidate] of value.matchAll(providerKeyCandidate)) {
    if (shannonEntropy(candidate) >= entropyThresholdBitsPerChar) return true;
  }
  return false;
}

export interface BuiltinScrubberOptions {
  redact?: (text: string) => RedactionResult;
}

export function builtinPresidioScrubber(options: BuiltinScrubberOptions = {}): Scrubber {
  const redact = options.redact ?? builtinRedact;
  return async (payload) => redact(payload).payload;
}

/**
 * Second pass, mirroring the external Gitleaks contract: verifies no known
 * secret shape survived. Throws so `ingestFailClosed` pauses ingest.
 */
export function builtinGitleaksScrubber(options: BuiltinScrubberOptions = {}): Scrubber {
  const redact = options.redact ?? builtinRedact;
  return async (payload) => {
    const { payload: cleaned } = redact(payload);
    if (retainsSecret(cleaned)) throw new Error("Built-in scrubber left a secret in the payload");
    return cleaned;
  };
}

/**
 * Checks string VALUES, not the serialized document.
 *
 * Testing the raw JSON text lets a keyword at the end of one value run into
 * the next field's punctuation -- a transcript containing "second pass:"
 * became `pass:","timestamp":"..."`, which reads as an unredacted secret and
 * halted the entire scan. Found against real history.
 */
function retainsSecret(payload: string): boolean {
  const document = parseDocument(payload);
  if (document === undefined) return valueRetainsSecret(payload);
  let found = false;
  const walk = (value: unknown): void => {
    if (found) return;
    if (typeof value === "string") { found = valueRetainsSecret(value); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(document);
  return found;
}
