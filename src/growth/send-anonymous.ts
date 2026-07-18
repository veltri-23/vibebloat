import { parseAnonymousIngest, type AnonymousIngestEvent } from "./ingest-endpoint";

export interface AnonymousSendOptions {
  endpoint?: string;
  optedIn: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function isHttpsEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function sendAnonymousEvent(event: AnonymousIngestEvent, options: AnonymousSendOptions): void {
  if (!options.optedIn || !options.endpoint || !isHttpsEndpoint(options.endpoint)) return;
  const envelope = { schema: "v1", consent: true, event } as const;
  if (!parseAnonymousIngest(envelope)) return;
  void Promise.resolve().then(() => (options.fetch ?? fetch)(options.endpoint!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
    keepalive: true,
    signal: AbortSignal.timeout(options.timeoutMs ?? 750),
  })).catch(() => undefined);
}
