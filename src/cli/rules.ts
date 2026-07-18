import type { Guard } from "../types";

export interface RuleSummary {
  action: Guard["action"]["type"];
  binds: string[];
  class: Guard["class"];
  confidence: Guard["confidence"] | null;
  enabled: boolean;
  id: string;
  tier: Guard["tier"] | null;
}

export function summarizeRules(guards: readonly Guard[]): RuleSummary[] {
  return guards.map((guard) => ({
    action: guard.action.type,
    binds: [...(guard.binds ?? [])].sort(),
    class: guard.class,
    confidence: guard.confidence ?? null,
    enabled: guard.enabled,
    id: guard.id,
    tier: guard.tier ?? null,
  })).sort((left, right) => left.id.localeCompare(right.id));
}
