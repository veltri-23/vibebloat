import { expect, test } from "bun:test";
import { OnboardingRunner } from "../../src/onboarding/runner";
import { getReturningGate, nextReturningGate } from "../../src/onboarding/returning";

test("runner records a human choice without selecting later gates", () => {
  const runner = new OnboardingRunner({ gate: "A1", answers: {} });
  expect(runner.current().question).toBe("First: should I protect just this project, or watch your work everywhere on this machine?");
  expect(runner.choose("What does this change?")).toEqual({ gate: "A1", answers: {} });
  expect(runner.choose("Just this project")).toEqual({ gate: "F0", answers: { A1: "Just this project" } });
});

test("returning paths keep their locked menu and routes", () => {
  expect(getReturningGate("R0").options).toEqual(["Something broke or a new problem", "A new project or tool", "Clean up or change my rules", "Just checking in / catch me up"]);
  expect(nextReturningGate("R0", "catch-up")).toBe("R4");
});
