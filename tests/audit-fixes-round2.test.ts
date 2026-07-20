import { describe, expect, test } from "bun:test";
import { getGate, canonicalGateChoice, nearestGateChoice, isGateChoice } from "../src/onboarding/gates";

describe("audit-2026-07-19 Block C+D fixes", () => {
  test("F0 question honestly describes install timing (audit M6 + C1)", () => {
    expect(getGate("F0").question).toMatch(/install actually runs after you approve/);
  });

  test("F1b copy dropped vague-benefit copy (audit M7)", () => {
    expect(getGate("F1b").question).not.toMatch(/for everyone/);
    expect(getGate("F1b").question).toMatch(/Stays local/);
  });

  test("A0 welcome copy matches 5-minute expectation (audit L12)", () => {
    expect(getGate("A0").question).not.toMatch(/about a minute/);
    expect(getGate("A0").question).toMatch(/about 5 minutes for a normal history/);
  });

  test("'No thanks' does not canonicalize to a different option (regression guard for M7 fix)", () => {
    // F1b's option label is "No thanks". The previous matcher canonicalized
    // "no thanks" to the LAST option (which was Cancel in some flows) due
    // to an over-broad decline alias. After the M7 fix the alias set
    // excludes "no thanks" so the exact-match path is taken.
    expect(isGateChoice("F1b", "No thanks")).toBe(true);
    expect(canonicalGateChoice("F1b", "No thanks")).toBe("No thanks");
  });

  test("'no' canonicalizes to the option after the recommended (audit M7 + H5)", () => {
    // A1's options: ["Just this project", "Everywhere (recommended for solo devs)"].
    // The decline alias should map "no" to the option before the recommended,
    // i.e. the "Just this project" (scope-narrowing) answer.
    const options = getGate("A1").options;
    const recommended = options.findIndex((o) => /recommended/i.test(o));
    expect(recommended).toBeGreaterThanOrEqual(0);
    const before = options[recommended - 1];
    expect(before).toBeDefined();
    expect(canonicalGateChoice("A1", "no")).toBe(before);
  });

  test("'yes' canonicalizes to the recommended option when one exists (audit H5)", () => {
    const options = getGate("A1").options;
    const recommended = options.find((o) => /recommended/i.test(o));
    expect(recommended).toBeDefined();
    expect(canonicalGateChoice("A1", "yes")).toBe(recommended);
  });

  test("near-miss surfaces a close option (audit H5)", () => {
    const result = nearestGateChoice("A1", "Everywear");
    expect(result).toBeDefined();
    expect(result!.option).toMatch(/Everywhere/);
    expect(result!.distance).toBeLessThanOrEqual(0.5);
  });
});
