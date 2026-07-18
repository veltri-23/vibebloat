import type { IngestStore, IngestTable } from "./ingest-endpoint";

export interface SupabaseEnvironment {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
}

export interface SupabaseStoreOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSupabaseIngestStore(environment: SupabaseEnvironment, options: SupabaseStoreOptions = {}): IngestStore | undefined {
  const baseUrl = environment.SUPABASE_URL?.replace(/\/+$/, "");
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
  const request = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1_500;

  return {
    async insert(table: IngestTable, row: Record<string, string>): Promise<void> {
      const response = await request(`${baseUrl}/rest/v1/${table}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          authorization: `Bearer ${serviceKey}`,
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error("External ingest rejected the event.");
    },
  };
}
