import { expect, test } from "bun:test";
import { getGate, nextGate } from "../src/onboarding/gates";

test("A1 uses locked scope prompt and advances to F0", () => {
  expect(getGate("A1")).toEqual({
    question: "First: should I protect just this project, or watch your work everywhere on this machine?",
    options: ["Just this project", "Everywhere (recommended for solo devs)"],
  });
  expect(nextGate("A1", "repo")).toBe("F0");
});

test("F0 only advances after explicit setup permission", () => {
  expect(nextGate("F0", "yes")).toBe("B1");
  expect(nextGate("F0", "more")).toBe("F0");
});
