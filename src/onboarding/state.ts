import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";

export interface OnboardingState {
  gate: string;
  answers: Record<string, string>;
  cancelled?: boolean;
}

export function saveOnboardingState(directory: string, state: OnboardingState): void {
  replaceGuardAtomically(join(directory, "onboarding.json"), `${JSON.stringify(state)}\n`);
}

export function loadOnboardingState(directory: string): OnboardingState | undefined {
  const path = join(directory, "onboarding.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as OnboardingState : undefined;
}
