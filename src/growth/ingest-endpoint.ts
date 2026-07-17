export interface AnonymousPayload { class: "A" | "B" | "C" | "D"; pattern: string; }

export function acceptAnonymousIngest(optedIn: boolean, payload: AnonymousPayload): { accepted: boolean } {
  if (!optedIn) return { accepted: false };
  if (/bearer\s+\S+|api[_-]?key|secret/i.test(payload.pattern)) throw new Error("Scrub required before ingest.");
  return { accepted: true };
}
