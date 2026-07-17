import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadOnboardingState, saveOnboardingState } from "../src/onboarding/state";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("cancelled onboarding saves and resumes exact gate progress", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-onboarding-"));
  tempDirectories.push(directory);
  saveOnboardingState(directory, { gate: "F1", answers: { scope: "machine" } });
  expect(loadOnboardingState(directory)).toEqual({ gate: "F1", answers: { scope: "machine" } });
});
