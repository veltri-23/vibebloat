import { expect, test } from "bun:test";
import { OnboardingRunner } from "../../src/onboarding/runner";
import { getReturningGate, nextReturningGate } from "../../src/onboarding/returning";

test("runner records a human choice without selecting later gates", () => {
  const runner = new OnboardingRunner({ gate: "A1", answers: {} });
  expect(runner.current().question).toBe("First: should I protect just this project, or watch your work everywhere on this machine?");
  expect(runner.choose("What does this change?")).toEqual({ gate: "A1", answers: {} });
  expect(runner.choose("Just this project")).toEqual({ gate: "F0", scope: "repo", answers: { A1: "Just this project" } });
});

test("returning paths keep their locked menu and routes", () => {
  expect(getReturningGate("R0").options).toEqual(["Something broke or a new problem", "A new project or tool", "Clean up or change my rules", "Just checking in / catch me up"]);
  expect(nextReturningGate("R0", "catch-up")).toBe("R4");
});

test("no-question gates auto-advance and Cancel persists any current gate", () => {
  const saved: unknown[] = [];
  const runner = new OnboardingRunner({ gate: "SCAN", answers: {} }, { scanOutcome: "found" }, { save: (state) => saved.push(state) });
  expect(runner.advanceAutomaticGates().gate).toBe("J0");
  expect(runner.choose("cancel")).toMatchObject({ gate: "J0", cancelled: true });
  expect(saved).toHaveLength(1);
});

test("SCAN remains pending until its owner supplies an outcome", () => {
  const runner = new OnboardingRunner({ gate: "SCAN", answers: {} });
  expect(runner.advanceAutomaticGates().gate).toBe("SCAN");
});

test("opening consent gate always waits for a human choice", () => {
  const runner = new OnboardingRunner({ gate: "A0", answers: {} });
  expect(runner.advanceAutomaticGates()).toMatchObject({ gate: "A0", answers: {} });
});

test("ASSIST uses FAQ first and applies only the recommended locked choice", () => {
  const runner = new OnboardingRunner({ gate: "A1", answers: {} });
  const response = runner.assist("recommend and apply", {
    faq: () => "FAQ answer.",
    repo: () => "Repo answer.",
    reasoning: () => "Reasoning answer.",
    recommendedOption: "Everywhere (recommended for solo devs)",
  });
  expect(response.answer).toBe("FAQ answer. Applied: Everywhere (recommended for solo devs). Want more detail?");
  expect(runner.snapshot().gate).toBe("F0");
});
