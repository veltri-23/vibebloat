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
    // Deliberately does not promise every secret is caught: this tier is a
    // pattern and entropy scrubber, not Presidio's full detector set.
    : "Scrubbing in-process with the built-in scrubber: known key formats, credentials in URLs, and high-entropy strings are removed before anything reaches a model, and ingest halts if a known secret survives. Only the mined rule is ever shared, never raw history.";
}
