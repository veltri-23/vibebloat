import { builtinGitleaksScrubber, builtinPresidioScrubber } from "./builtin";
import { createGitleaksCommandScrubber } from "./gitleaks";
import { createPresidioCommandScrubber, type Scrubber } from "./presidio";
import { resolveControlledScrubberCommands, type ControlledScrubberCommands } from "./controlled-release";

export type ScrubberTier = "signed" | "builtin";

export interface ResolvedScrubbers {
  tier: ScrubberTier;
  presidio: Scrubber;
  gitleaks: Scrubber;
  /** Present when the signed tier was attempted and rejected. */
  signedUnavailableReason?: string;
}

export interface ResolveScrubberOptions {
  packageRoot?: string;
  resolveControlled?: (packageRoot?: string) => ControlledScrubberCommands;
}

/**
 * Scrubbing must always happen; a missing signed release must not make history
 * ingest unreachable. A signed distribution is preferred because it pins the
 * scrubber against tampering, but when running from source or an npm install
 * the executing code IS the scrubber, so the in-process tier is used instead.
 * Both tiers fail closed: a surviving secret halts ingest.
 */
export function resolveScrubbers(options: ResolveScrubberOptions = {}): ResolvedScrubbers {
  const resolveControlled = options.resolveControlled ?? resolveControlledScrubberCommands;
  try {
    const commands = resolveControlled(options.packageRoot);
    return {
      tier: "signed",
      presidio: createPresidioCommandScrubber(commands.presidio),
      gitleaks: createGitleaksCommandScrubber(commands.gitleaks),
    };
  } catch (error) {
    return {
      tier: "builtin",
      presidio: builtinPresidioScrubber(),
      gitleaks: builtinGitleaksScrubber(),
      signedUnavailableReason: error instanceof Error ? error.message : "Signed release unavailable.",
    };
  }
}

export function scrubberTierNotice(resolved: ResolvedScrubbers): string {
  return resolved.tier === "signed"
    ? "Scrubbing with the signed VibeBloat release."
    : "Scrubbing in-process with the built-in scrubber. History never leaves this machine; ingest halts if a secret survives.";
}
