export interface AnonymousPayload {
  class: "A" | "B" | "C" | "D";
  pattern: string;
}

export type AnonymousIngestEvent =
  | { type: "onboarding"; gate: string; choice: "a" | "b" | "c" | "d" | "e" }
  | { type: "return-session"; action: "review" | "tune" | "reject" | "other" }
  | { type: "incident"; class: AnonymousPayload["class"]; guardId: string; pattern: string }
  | { type: "telemetry"; metric: "guard-fired"; guardId: string; agent: "claude-code" | "codex" | "hermes" | "openclaw" | "shell" }
  | { type: "telemetry"; metric: "doctor-health"; status: "healthy" | "degraded" };

export interface AnonymousIngestEnvelope {
  schema: "v1";
  consent: true;
  event: AnonymousIngestEvent;
}

export type IngestTable = "onboarding_events" | "return_sessions" | "incidents" | "telemetry";

export interface IngestStore {
  insert(table: IngestTable, row: Record<string, string>): Promise<void>;
}

export interface IngestHandlerOptions {
  store?: IngestStore;
  now?: () => Date;
}

const maxBodyBytes = 8_192;
const maxPatternLength = 256;
const secretPattern = /(?:authorization\s*[:=]\s*bearer|bearer\s+[a-z0-9._~+\/-]{6,}|(?:api[_-]?key|password|secret|token)\s*[:=]|-----begin [a-z ]*private key-----|\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[a-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.|\b[a-z0-9_~+\/=.-]{32,}\b)/i;
const emailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const pathPattern = /(?:[a-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|(?:file|https?):\/\/|(?:^|[\s"'`])~?[\\/]|(?:^|[\s"'`])(?:\.{0,2}[\\/])?[a-z0-9_.-]+[\\/][a-z0-9_.\/-]+)/i;
const transcriptPattern = /(?:^|\s)(?:user|assistant|system|tool)\s*:/i;
const sourcePattern = /(?:^|\s)(?:import|export|function|class|const|let|var)\s+[a-z_$]|=>\s*[{(]/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\r\n\0]/.test(value)
    && !secretPattern.test(value)
    && !emailPattern.test(value)
    && !pathPattern.test(value)
    && !transcriptPattern.test(value)
    && !sourcePattern.test(value);
}

function isGuardId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
}

function isGate(value: unknown): value is string {
  return typeof value === "string" && /^(?:[A-O]|F1b)$/.test(value);
}

function parseEvent(value: unknown): AnonymousIngestEvent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "onboarding") {
    if (!hasExactKeys(value, ["type", "gate", "choice"]) || !isGate(value.gate) || !["a", "b", "c", "d", "e"].includes(String(value.choice))) return undefined;
    return value as unknown as AnonymousIngestEvent;
  }
  if (value.type === "return-session") {
    if (!hasExactKeys(value, ["type", "action"]) || !["review", "tune", "reject", "other"].includes(String(value.action))) return undefined;
    return value as unknown as AnonymousIngestEvent;
  }
  if (value.type === "incident") {
    if (!hasExactKeys(value, ["type", "class", "guardId", "pattern"])) return undefined;
    if (!["A", "B", "C", "D"].includes(String(value.class)) || !isGuardId(value.guardId) || !isSafeText(value.pattern, maxPatternLength)) return undefined;
    return value as unknown as AnonymousIngestEvent;
  }
  if (value.type === "telemetry" && value.metric === "guard-fired") {
    if (!hasExactKeys(value, ["type", "metric", "guardId", "agent"]) || !isGuardId(value.guardId)) return undefined;
    if (!["claude-code", "codex", "hermes", "openclaw", "shell"].includes(String(value.agent))) return undefined;
    return value as unknown as AnonymousIngestEvent;
  }
  if (value.type === "telemetry" && value.metric === "doctor-health") {
    if (!hasExactKeys(value, ["type", "metric", "status"]) || !["healthy", "degraded"].includes(String(value.status))) return undefined;
    return value as unknown as AnonymousIngestEvent;
  }
  return undefined;
}

export function parseAnonymousIngest(value: unknown): AnonymousIngestEnvelope | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "consent", "event"])) return undefined;
  if (value.schema !== "v1" || value.consent !== true) return undefined;
  const event = parseEvent(value.event);
  return event ? { schema: "v1", consent: true, event } : undefined;
}

function rowFor(envelope: AnonymousIngestEnvelope, receivedAt: string): { table: IngestTable; row: Record<string, string> } {
  const common = { schema_version: envelope.schema, received_at: receivedAt };
  const event = envelope.event;
  if (event.type === "onboarding") return { table: "onboarding_events", row: { ...common, gate: event.gate, choice: event.choice } };
  if (event.type === "return-session") return { table: "return_sessions", row: { ...common, action: event.action } };
  if (event.type === "incident") return { table: "incidents", row: { ...common, class: event.class, guard_id: event.guardId, pattern: event.pattern } };
  if (event.metric === "guard-fired") return { table: "telemetry", row: { ...common, metric: event.metric, guard_id: event.guardId, agent: event.agent } };
  return { table: "telemetry", row: { ...common, metric: event.metric, status: event.status } };
}

function json(status: number, body: Record<string, unknown>, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function handleAnonymousIngestRequest(request: Request, options: IngestHandlerOptions = {}): Promise<Response> {
  if (request.method !== "POST") return json(405, { accepted: false, persisted: false }, { allow: "POST" });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return json(415, { accepted: false, persisted: false });
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBodyBytes) return json(413, { accepted: false, persisted: false });

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json(400, { accepted: false, persisted: false });
  }
  if (new TextEncoder().encode(raw).byteLength > maxBodyBytes) return json(413, { accepted: false, persisted: false });

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return json(400, { accepted: false, persisted: false });
  }
  const envelope = parseAnonymousIngest(value);
  if (!envelope) return json(400, { accepted: false, persisted: false });
  if (!options.store) return json(202, { accepted: true, persisted: false });

  const target = rowFor(envelope, (options.now ?? (() => new Date()))().toISOString());
  try {
    await options.store.insert(target.table, target.row);
    return json(202, { accepted: true, persisted: true });
  } catch {
    return json(202, { accepted: true, persisted: false });
  }
}

export function acceptAnonymousIngest(optedIn: boolean, payload: AnonymousPayload): { accepted: boolean } {
  if (!optedIn) return { accepted: false };
  if (!["A", "B", "C", "D"].includes(payload.class) || !isSafeText(payload.pattern, maxPatternLength)) throw new Error("Scrub required before ingest.");
  return { accepted: true };
}
