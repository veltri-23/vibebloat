import type { Scrubber } from "./presidio";

export async function scrubWithGitleaks(payload: string, scrub: Scrubber): Promise<string> {
  return scrub(payload);
}
