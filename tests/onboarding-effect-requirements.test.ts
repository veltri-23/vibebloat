import { expect, test } from "bun:test";
import {
  validateOnboardingEffectRequirements,
  type EffectGateId,
  type OnboardingEffectEvidence,
  type OnboardingEffectEvidenceKey,
} from "../src/onboarding/effect-requirements";

const requiredEffects: Array<{
  gate: EffectGateId;
  choice: string;
  evidence: OnboardingEffectEvidence;
  missing: OnboardingEffectEvidenceKey[];
}> = [
  {
    gate: "F6",
    choice: "Yes",
    evidence: { subscriberCaptureValidated: true, starterPackInstalled: true },
    missing: ["subscriberCaptureValidated", "starterPackInstalled"],
  },
  { gate: "N1", choice: "Star", evidence: { githubStarVerified: true }, missing: ["githubStarVerified"] },
  { gate: "N2", choice: "Yes, notify me (uses your email)", evidence: { subscriptionStored: true }, missing: ["subscriptionStored"] },
  { gate: "O1", choice: "Yes", evidence: { dailyScheduleVerified: true }, missing: ["dailyScheduleVerified"] },
  { gate: "O2", choice: "Yes", evidence: { agentCronVerified: true }, missing: ["agentCronVerified"] },
  { gate: "O3", choice: "Auto-update with rollback", evidence: { updaterScheduleVerified: true }, missing: ["updaterScheduleVerified"] },
];

for (const effect of requiredEffects) {
  test(`${effect.gate} blocks advancement without verified effect evidence`, () => {
    expect(validateOnboardingEffectRequirements(effect.gate, effect.choice)).toEqual({
      ok: false,
      choice: effect.choice,
      reason: "missing-evidence",
      missing: effect.missing,
    });
    expect(validateOnboardingEffectRequirements(effect.gate, effect.choice, effect.evidence)).toEqual({
      ok: true,
      choice: effect.choice,
      missing: [],
    });
  });
}

test("F6 requires both subscriber capture and starter pack receipts", () => {
  expect(validateOnboardingEffectRequirements("F6", "a", { subscriberCaptureValidated: true })).toEqual({
    ok: false,
    choice: "Yes",
    reason: "missing-evidence",
    missing: ["starterPackInstalled"],
  });
});

test("skip, manual, and notify choices need no effect evidence", () => {
  expect(validateOnboardingEffectRequirements("F6", "Skip").ok).toBe(true);
  expect(validateOnboardingEffectRequirements("N1", "Maybe later").ok).toBe(true);
  expect(validateOnboardingEffectRequirements("N2", "Skip").ok).toBe(true);
  expect(validateOnboardingEffectRequirements("O1", "Manual only").ok).toBe(true);
  expect(validateOnboardingEffectRequirements("O2", "No").ok).toBe(true);
  expect(validateOnboardingEffectRequirements("O3", "Just let me know (recommended)").ok).toBe(true);
});

test("invalid free-form text fails closed", () => {
  expect(validateOnboardingEffectRequirements("O3", "do whatever")).toEqual({
    ok: false,
    reason: "invalid-choice",
    missing: [],
  });
});
