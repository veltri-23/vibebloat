import type { Guard } from "./types";

const maximumFieldLength = 96;
/**
 * The "why" line carries the remediation — the one thing the user acts on.
 * Trimming it at the shared field budget cut advice mid-sentence, so it gets
 * its own. Still one content line, per BLOCK-RECEIPT-SPEC.
 */
const maximumReasonLength = 140;

const ANSI_RESET = "\x1b[0m";
const ANSI_RED = "\x1b[31m";
const ANSI_YELLOW = "\x1b[33m";

function scrub(value: string, fallback: string, limit = maximumFieldLength): string {
  const text = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|authorization|password|secret|token)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b(user(?:name)?)\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b/g, "<redacted-token>")
    .replace(/\b[A-Za-z0-9_~+/=-]{32,}\b/g, "<redacted-token>")
    .replace(/\b[A-Z]:[\\/][^\s"'`<>|]+/gi, "<absolute-path>")
    .replace(/\\\\[^\s"'`<>|]+/g, "<absolute-path>")
    .replace(/(^|[\s("'`])(?:~\/|\/)[^\s"'`<>|]+/g, "$1<absolute-path>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
  return text || fallback;
}

export function isReceiptColorEnabled(): boolean {
  if (typeof process === "undefined" || !process.stdout) return false;
  return Boolean((process.stdout as { isTTY?: boolean }).isTTY);
}

export function renderGuardReceipt(guard: Guard, reason: string): string | undefined {
  if (guard.action.type !== "block" && guard.action.type !== "warn") return undefined;
  const status = guard.action.type === "block" ? "BLOCKED" : "WARNING";
  const guardId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(guard.id) ? guard.id : "redacted";
  const guardClass = guard.class === "A" || guard.class === "B" || guard.class === "C" || guard.class === "D" ? guard.class : "redacted";
  const incident = scrub(guard.provenance.incident, "redacted");
  const why = scrub(reason, "sensitive detail withheld", maximumReasonLength);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(guard.provenance.date) ? guard.provenance.date : "1970-01-01";
  const fix = guard.action.type === "block"
    ? `vibebloat allow ${guardId} --once`
    : `vibebloat disable ${guardId}`;
  const colorOpen = isReceiptColorEnabled()
    ? (guard.action.type === "block" ? ANSI_RED : ANSI_YELLOW)
    : "";
  const colorClose = colorOpen ? ANSI_RESET : "";
  return [
    `${colorOpen}${status}${colorClose}  guard: ${guardId}  class: ${guardClass}`,
    `incident: ${incident}  date: ${date}`,
    `why: ${why}`,
    `fix: ${fix}`,
  ].join("\n");
}
