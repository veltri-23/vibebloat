import { createCommandScrubber, type CommandExecutor } from "./command";
import type { Scrubber } from "./presidio";

export async function scrubWithGitleaks(payload: string, scrub: Scrubber): Promise<string> {
  return scrub(payload);
}

/** Gitleaks wrapper must report an empty structured findings array before payload proceeds. */
export function createGitleaksCommandScrubber(command: readonly string[], execute?: CommandExecutor): Scrubber {
  return createCommandScrubber("Gitleaks", command, execute, true);
}
