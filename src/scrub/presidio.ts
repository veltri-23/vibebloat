export type Scrubber = (payload: string) => Promise<string>;

import { createCommandScrubber, type CommandExecutor } from "./command";

export async function scrubWithPresidio(payload: string, scrub: Scrubber): Promise<string> {
  return scrub(payload);
}

/** Runs a Presidio JSON wrapper without placing sensitive payloads in command arguments. */
export function createPresidioCommandScrubber(command: readonly string[], execute?: CommandExecutor): Scrubber {
  return createCommandScrubber("Presidio", command, execute);
}
