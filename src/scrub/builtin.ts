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

const namedPatterns: Array<{ name: string; re: RegExp; replace: string }> = [
  { name: "bearer", re: /Bearer\s+\S+/gi, replace: "Bearer <redacted>" },
  {
    name: "provider_key",
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})\b/g,
    replace: "<redacted-key>",
  },
  { name: "api_key", re: /\bapi[_-]?key\s*[:=]\s*\S+/gi, replace: "api_key=<redacted>" },
  { name: "password", re: /\bpassword\s*[:=]\s*\S+/gi, replace: "password=<redacted>" },
  { name: "token", re: /\btoken\s*[:=]\s*\S+/gi, replace: "token=<redacted>" },
  { name: "secret", re: /\bsecret\s*[:=]\s*\S+/gi, replace: "secret=<redacted>" },
  { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replace: "<redacted-private-key>" },
  { name: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replace: "<redacted-email>" },
  { name: "absolute_path", re: /\b[A-Z]:\\[^\s"'`<>|]+/gi, replace: "<absolute-path>" },
  { name: "absolute_path_unix", re: /(^|[\s("'`])(?:\/[\w.\-]+)+\/?/g, replace: "$1<absolute-path>" },
];

/**
 * Candidate credential shapes for entropy scoring: long runs of credential-ish
 * characters. Requires mixed case or digits/symbols so ordinary long words are
 * never scored.
 */
const entropyCandidate = /\b(?=[A-Za-z0-9+/=_-]*[0-9+/=_-])(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{24,}\b/g;
const entropyThresholdBitsPerChar = 3.5;

export function builtinRedact(text: string): RedactionResult {
  let cleaned = text;
  const findings: RedactionFinding[] = [];

  for (const pattern of namedPatterns) {
    const matches = cleaned.match(pattern.re);
    if (matches?.length) {
      findings.push({ name: pattern.name, count: matches.length });
      cleaned = cleaned.replace(pattern.re, pattern.replace);
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

/** Secrets that must never survive redaction. Presence after scrubbing halts ingest. */
const survivingSecret = /\bBearer\s+(?!<redacted>)\S+|\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

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
    if (survivingSecret.test(cleaned)) throw new Error("Built-in scrubber left a secret in the payload");
    return cleaned;
  };
}
