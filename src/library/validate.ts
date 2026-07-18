import { match } from "../match";
import { parseGuard } from "../schema";
import type { Event, Guard } from "../types";

const knownBinds = new Set(["claude-code", "codex", "hermes", "openclaw"]);
const sensitiveText = /(?:\b(?:sk|ghp|ghs|xox[a-z]?|AKIA|sk_live)_[A-Za-z0-9_-]+\b|(?:[A-Za-z]:\\|\/Users\/))/i;

export interface GuardTestVector {
  positive: Event;
  negative: Event;
}

export interface CommunityGuardValidation {
  guard?: Guard;
  errors: string[];
}

export function validateCommunityGuard(candidate: unknown, vector: GuardTestVector): CommunityGuardValidation {
  let guard: Guard;
  try {
    guard = parseGuard(candidate);
  } catch (error) {
    return { errors: [error instanceof Error ? error.message : "Guard schema is invalid."] };
  }

  const errors: string[] = [];
  if (guard.tier !== "community") errors.push("Community guards must use tier community.");
  if (guard.confidence !== "high" && guard.confidence !== "low") errors.push("Community guards require explicit confidence.");
  if (!Array.isArray(guard.binds) || guard.binds.length === 0 || guard.binds.some((bind) => !knownBinds.has(bind))) errors.push("Community guards require known binds.");
  if (guard.confidence === "low" && guard.action.type !== "warn") errors.push("Low-confidence community guards must warn.");
  if (guard.match.chokepoint === "shell" && !guard.match.command) errors.push("Shell guard requires a command matcher.");
  if (guard.match.chokepoint === "file" && !guard.match.path) errors.push("File guard requires a path matcher.");
  if (sensitiveText.test(JSON.stringify(guard))) errors.push("Community guard contains secret, username, or absolute path data.");

  if (!match(guard, vector.positive).fired) errors.push("Positive test vector does not fire.");
  if (match(guard, vector.negative).fired) errors.push("Negative test vector fires.");
  return { guard, errors };
}
