import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";
import type { GuardScope } from "../guard-home";
import type { RunnerKind } from "./detect-runner";
import type { GuardReviewDecision, OnboardingCheckpoint } from "./coordinator";
import type { OnboardingPreferences } from "./preferences";

export interface OnboardingState {
  gate: string;
  answers: Record<string, string>;
  runner?: RunnerKind;
  scope?: GuardScope;
  cancelled?: boolean;
  coordinator?: OnboardingCheckpoint;
  reviewDecisions?: GuardReviewDecision[];
  returningConversations?: ReturningConversation[];
  preferences?: OnboardingPreferences;
}

export interface ReturningConversation {
  reason: string;
  detail?: string;
}

export function saveOnboardingState(directory: string, state: OnboardingState): void {
  replaceGuardAtomically(join(directory, "onboarding.json"), `${JSON.stringify(state)}\n`);
}

export function loadOnboardingState(directory: string): OnboardingState | undefined {
  const path = join(directory, "onboarding.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as OnboardingState : undefined;
}
