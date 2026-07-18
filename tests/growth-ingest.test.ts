import { describe, expect, test } from "bun:test";
import {
  acceptAnonymousIngest,
  handleAnonymousIngestRequest,
  parseAnonymousIngest,
  type IngestStore,
} from "../src/growth/ingest-endpoint";
import { sendAnonymousEvent } from "../src/growth/send-anonymous";
import { createSupabaseIngestStore } from "../src/growth/supabase-store";
import ingest from "../api/ingest";

function post(body: unknown): Request {
  return new Request("https://vibebloat.test/api/ingest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const incident = {
  schema: "v1",
  consent: true,
  event: { type: "incident", class: "A", guardId: "git-stash-u", pattern: "git stash -u" },
} as const;

describe("closed anonymous ingest schema", () => {
  test("accepts only known opted-in fields", () => {
    expect(parseAnonymousIngest(incident)).toEqual(incident);
    expect(parseAnonymousIngest({ ...incident, transcript: "user: raw history" })).toBeUndefined();
    expect(parseAnonymousIngest({ ...incident, consent: false })).toBeUndefined();
    expect(parseAnonymousIngest({ ...incident, event: { ...incident.event, evidence: "local context" } })).toBeUndefined();
  });

  test("rejects secrets, paths, transcripts, and source", () => {
    for (const pattern of [
      "Authorization: Bearer abcdefghi",
      "token=abcdefghi",
      "credential abcdefghijklmnopqrstuvwxyz123456",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "open C:\\Users\\person\\project\\secret.txt",
      "read /home/person/project/file.ts",
      "inspect src/private/customer.ts",
      "email person@example.com",
      "user: delete my work",
      "const token = process.env.TOKEN",
    ]) {
      expect(parseAnonymousIngest({ ...incident, event: { ...incident.event, pattern } })).toBeUndefined();
    }
  });

  test("keeps compatibility helper opt-in and scrubbed", () => {
    expect(acceptAnonymousIngest(false, { class: "A", pattern: "git stash -u" })).toEqual({ accepted: false });
    expect(acceptAnonymousIngest(true, { class: "A", pattern: "git stash -u" })).toEqual({ accepted: true });
    expect(() => acceptAnonymousIngest(true, { class: "A", pattern: "Bearer secret-token" })).toThrow("Scrub required");
  });
});

describe("Vercel ingest handler", () => {
  test("exports the Vercel Web Handler contract", () => {
    expect(typeof ingest.fetch).toBe("function");
  });

  test("routes every anonymous stream to its dedicated table", async () => {
    const writes: unknown[] = [];
    const store: IngestStore = { insert: async (table, row) => { writes.push({ table, row }); } };
    const events = [
      { type: "onboarding", gate: "F1b", choice: "a" },
      { type: "return-session", action: "tune" },
      { type: "telemetry", metric: "guard-fired", guardId: "git-stash-u", agent: "codex" },
      { type: "telemetry", metric: "doctor-health", status: "healthy" },
    ];
    for (const event of events) {
      const response = await handleAnonymousIngestRequest(post({ schema: "v1", consent: true, event }), { store, now: () => new Date("2026-07-18T12:00:00.000Z") });
      expect(response.status).toBe(202);
    }
    expect(writes.map((write) => (write as { table: string }).table)).toEqual([
      "onboarding_events",
      "return_sessions",
      "telemetry",
      "telemetry",
    ]);
  });

  test("persists a minimal row through configured external storage", async () => {
    const writes: unknown[] = [];
    const store: IngestStore = { insert: async (table, row) => { writes.push({ table, row }); } };
    const response = await handleAnonymousIngestRequest(post(incident), { store, now: () => new Date("2026-07-18T12:00:00.000Z") });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, persisted: true });
    expect(writes).toEqual([{
      table: "incidents",
      row: {
        schema_version: "v1",
        received_at: "2026-07-18T12:00:00.000Z",
        class: "A",
        guard_id: "git-stash-u",
        pattern: "git stash -u",
      },
    }]);
  });

  test("does not claim persistence without a database binding", async () => {
    const response = await handleAnonymousIngestRequest(post(incident));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, persisted: false });
  });

  test("fails silent when external storage is unavailable", async () => {
    const store: IngestStore = { insert: async () => { throw new Error("database offline"); } };
    const response = await handleAnonymousIngestRequest(post(incident), { store });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, persisted: false });
  });

  test("rejects malformed and oversized requests before storage", async () => {
    let writes = 0;
    const store: IngestStore = { insert: async () => { writes += 1; } };
    const malformed = await handleAnonymousIngestRequest(post({ ...incident, raw: "transcript" }), { store });
    const oversized = await handleAnonymousIngestRequest(new Request("https://vibebloat.test/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9000" },
      body: "{}",
    }), { store });
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(writes).toBe(0);
  });
});

test("Supabase store uses server credentials and rejects incomplete config", async () => {
  expect(createSupabaseIngestStore({})).toBeUndefined();
  expect(createSupabaseIngestStore({ SUPABASE_URL: "http://unsafe.test", SUPABASE_SERVICE_ROLE_KEY: "server-key" })).toBeUndefined();
  expect(createSupabaseIngestStore({ SUPABASE_URL: "https://attacker.test", SUPABASE_SERVICE_ROLE_KEY: "server-key" })).toBeUndefined();
  expect(createSupabaseIngestStore({ SUPABASE_URL: "https://project.supabase.co/unsafe", SUPABASE_SERVICE_ROLE_KEY: "server-key" })).toBeUndefined();
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const store = createSupabaseIngestStore({
    SUPABASE_URL: "https://project.supabase.co/",
    SUPABASE_SERVICE_ROLE_KEY: "server-key",
  }, {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  });
  await store!.insert("telemetry", { metric: "guard-fired" });
  expect(requests[0]!.url).toBe("https://project.supabase.co/rest/v1/telemetry");
  expect(new Headers(requests[0]!.init!.headers).get("authorization")).toBe("Bearer server-key");
});

test("client transport is opt-in and always fail-silent", async () => {
  let calls = 0;
  const failingFetch = (async () => { calls += 1; throw new Error("offline"); }) as typeof fetch;
  expect(sendAnonymousEvent(incident.event, { endpoint: "https://vibebloat.test/api/ingest", optedIn: true, fetch: failingFetch })).toBeUndefined();
  sendAnonymousEvent(incident.event, { endpoint: "https://vibebloat.test/api/ingest", optedIn: false, fetch: failingFetch });
  sendAnonymousEvent({ ...incident.event, pattern: "C:\\Users\\person\\secret.txt" }, { endpoint: "https://vibebloat.test/api/ingest", optedIn: true, fetch: failingFetch });
  await Bun.sleep(0);
  expect(calls).toBe(1);
});

test("Supabase schema exposes no direct anonymous table access", async () => {
  const migration = await Bun.file(new URL("../supabase/migrations/202607180001_anonymous_ingest.sql", import.meta.url)).text();
  expect(migration.match(/enable row level security/g)?.length).toBe(4);
  expect(migration).toContain("revoke all on onboarding_events, return_sessions, incidents, telemetry from anon, authenticated;");
  expect(migration).toContain("grant insert on onboarding_events, return_sessions, incidents, telemetry to service_role;");
});
