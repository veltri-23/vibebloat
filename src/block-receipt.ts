import type { Guard } from "./types";

const maximumFieldLength = 96;

function scrub(value: string, fallback: string): string {
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
    .slice(0, maximumFieldLength);
  return text || fallback;
}

export function renderGuardReceipt(guard: Guard, reason: string): string | undefined {
  if (guard.action.type !== "block" && guard.action.type !== "warn") return undefined;
  const status = guard.action.type === "block" ? "BLOCKED" : "WARNING";
  const guardId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(guard.id) ? guard.id : "redacted";
  const guardClass = guard.class === "A" || guard.class === "B" || guard.class === "C" || guard.class === "D" ? guard.class : "redacted";
  const incident = scrub(guard.provenance.incident, "redacted");
  const why = scrub(reason, "sensitive detail withheld");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(guard.provenance.date) ? guard.provenance.date : "1970-01-01";
  const fix = guard.action.type === "block"
    ? `vibebloat allow ${guardId} --once`
    : `vibebloat disable ${guardId}`;
  return [
    `${status}  guard: ${guardId}  class: ${guardClass}`,
    `incident: ${incident}  date: ${date}`,
    `why: ${why}`,
    `fix: ${fix}`,
  ].join("\n");
}
