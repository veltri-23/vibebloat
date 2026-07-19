import { expect, test } from "bun:test";
import { getGate, nextFirstRunGate, renderGate } from "../../src/onboarding/gates";

test("locked prompts remain exact and only bracket values render", () => {
  expect(getGate("F1").question).toBe("Quick note on privacy: I read your old sessions right here on your computer — nothing gets uploaded. I hide any passwords or keys before I even look. And you approve every rule before it turns on. One optional thing: I can share the mistake patterns — never your code — to help protect other developers. It's on by default, but you can flip it off. Good to go?");
  expect(renderGate("F3", { historySize: "2 GB", deepScanMinutes: 90 }).question).toBe("Your history is pretty big (2 GB) — a full deep look is about 90 minutes. How do you want it?");
});

test("conditional gates skip only under their locked conditions", () => {
  expect(nextFirstRunGate("D1", "use", { knowledgeToolsDetected: false })).toBe("E2");
  expect(nextFirstRunGate("D1", "use", { knowledgeToolsDetected: true, staleSourceSelected: true })).toBe("D1.1");
  expect(nextFirstRunGate("F2.1", "", { historyLarge: false })).toBe("F4");
  expect(nextFirstRunGate("F2.1", "", { historyLarge: true })).toBe("F3");
  expect(nextFirstRunGate("O1", "yes", { hasHermesOrOpenClaw: false })).toBe("O3");
  expect(nextFirstRunGate("O1", "yes", { hasHermesOrOpenClaw: true })).toBe("O2");
});

test("review, scan, and cancellation branches remain resumable", () => {
  expect(nextFirstRunGate("SCAN", "", { scanOutcome: "empty" })).toBe("G-empty");
  expect(nextFirstRunGate("SCAN", "", { scanOutcome: "zero" })).toBe("I-zero");
  expect(nextFirstRunGate("J1", "change", { reviewsRemaining: 2 })).toBe("J2");
  expect(nextFirstRunGate("J3", "no", { reviewsRemaining: 1 })).toBe("K");
  expect(nextFirstRunGate("F1", "cancel")).toBe("CANCELLED");
});

test("review conditions reach the locked unsure and overlap gates", () => {
  expect(nextFirstRunGate("J0", "One at a time", { reviewUncertain: true })).toBe("J1-unsure");
  expect(nextFirstRunGate("J0", "One at a time", { reviewOverlap: true })).toBe("J-cluster");
});
