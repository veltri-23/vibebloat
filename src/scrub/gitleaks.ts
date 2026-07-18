import { createCommandScrubber, type CommandExecutor } from "./command";
import type { Scrubber } from "./presidio";

export async function scrubWithGitleaks(payload: string, scrub: Scrubber): Promise<string> {
  return scrub(payload);
}

/** Gitleaks wrapper must report an empty structured findings array before payload proceeds. */
export function createGitleaksCommandScrubber(command: readonly string[], execute?: CommandExecutor): Scrubber {
  const scrub = createCommandScrubber("Gitleaks", command, execute, true);
  return async (payload) => {
    const scrubbed = await scrub(payload);
    if (/\bbearer\s+(?!<redacted>)\S+/i.test(scrubbed)) throw new Error("Gitleaks left a bearer token");
    return scrubbed;
  };
}
