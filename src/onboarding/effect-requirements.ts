import { getGate, isGateChoice, type GateChoice, type GateId } from "./gates";

export type EffectGateId = Extract<GateId, "F6" | "N1" | "N2" | "O1" | "O2" | "O3">;

export interface OnboardingEffectEvidence {
  subscriberCaptureValidated?: boolean;
  starterPackInstalled?: boolean;
  githubStarVerified?: boolean;
  subscriptionStored?: boolean;
  dailyScheduleVerified?: boolean;
  agentCronVerified?: boolean;
  updaterScheduleVerified?: boolean;
}

export type OnboardingEffectEvidenceKey = keyof OnboardingEffectEvidence;

export type EffectRequirementsResult =
  | { ok: true; choice: string; missing: [] }
  | { ok: false; choice?: string; reason: "invalid-choice" | "missing-evidence"; missing: OnboardingEffectEvidenceKey[] };

const requirements: Record<EffectGateId, { option: number; evidence: OnboardingEffectEvidenceKey[] }> = {
  F6: { option: 0, evidence: ["subscriberCaptureValidated", "starterPackInstalled"] },
  N1: { option: 0, evidence: ["githubStarVerified"] },
  N2: { option: 0, evidence: ["subscriptionStored"] },
  O1: { option: 0, evidence: ["dailyScheduleVerified"] },
  O2: { option: 0, evidence: ["agentCronVerified"] },
  O3: { option: 1, evidence: ["updaterScheduleVerified"] },
};

function lockedChoice(gate: EffectGateId, choice: GateChoice): string | undefined {
  if (!isGateChoice(gate, choice)) return undefined;
  const options = getGate(gate).options;
  if (typeof choice === "number") return options[choice];

  const value = choice.trim().toLowerCase();
  const aliasIndex = /^[a-z]$/.test(value) ? value.charCodeAt(0) - 97 : Number(value) - 1;
  if (Number.isInteger(aliasIndex) && options[aliasIndex]) return options[aliasIndex];
  return options.find((option) => option.toLowerCase() === value);
}

/** Fail closed until every side effect promised by the selected locked choice has proof. */
export function validateOnboardingEffectRequirements(
  gate: EffectGateId,
  choice: GateChoice,
  evidence: OnboardingEffectEvidence = {},
): EffectRequirementsResult {
  const selected = lockedChoice(gate, choice);
  if (!selected) return { ok: false, reason: "invalid-choice", missing: [] };

  const requirement = requirements[gate];
  if (selected !== getGate(gate).options[requirement.option]) return { ok: true, choice: selected, missing: [] };

  const missing = requirement.evidence.filter((key) => evidence[key] !== true);
  return missing.length === 0
    ? { ok: true, choice: selected, missing: [] }
    : { ok: false, choice: selected, reason: "missing-evidence", missing };
}
