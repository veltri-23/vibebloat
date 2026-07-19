import { expect, test } from "bun:test";
import { gatePlaceholders, gateValues, renderGate, type GateId } from "../src/onboarding/gates";
import { OnboardingRunner } from "../src/onboarding/runner";

const everyGate: GateId[] = [
  "A0", "A1", "F0", "B1", "B1.missing", "B1.ignore", "D1", "D1.1",
  "E1", "E1.1", "E2", "F1", "F1b", "F2", "F2.1", "F3", "F4", "F5", "F6",
  "SCAN", "G-empty", "I1", "I-zero", "J0", "J1", "J1-unsure", "J-cluster", "J2", "J3",
  "K", "K-conflict", "K-shim-only", "L1", "M", "N1", "N2", "O1", "O2", "O3", "END",
];

// Every placeholder must be a semantic NAME, never a sample value. `[1,453]`
// can only be filled by values["1,453"], so hardcoded figures render as one
// developer's numbers on every other developer's machine.
test("no gate placeholder is a literal sample value", () => {
  for (const gate of everyGate) {
    for (const name of gatePlaceholders(gate)) {
      expect(name).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
    }
  }
});

test("gateValues fills every placeholder from real scan data", () => {
  const values = gateValues({
    sessionsScanned: 312,
    incidentsFound: 4,
    confidentCount: 3,
    uncertainCount: 1,
    hoursLost: 2.5,
    estimatedMinutes: 3,
    historyBytes: 12_400_000,
    deepScanMinutes: 9,
    environments: ["Claude Code", "Codex"],
    staleEnvironment: "Cursor",
    staleDays: 94,
    topIncidentDate: "2026-07-15",
    topIncidentCommand: "git stash -u",
    quote: "it deleted my files",
    knowledgeTool: "CodeGraph",
    hermesLabel: "Hermes",
  });

  for (const gate of everyGate) {
    const rendered = renderGate(gate, values);
    const unfilled = [rendered.question, ...rendered.options].join(" ").match(/\[[^\]]+\]/g);
    expect(unfilled).toBeNull();
  }
});

test("different machines render different numbers", () => {
  const mine = renderGate("I1", gateValues({ sessionsScanned: 1453, incidentsFound: 12, hoursLost: 6.5 }));
  const theirs = renderGate("I1", gateValues({ sessionsScanned: 20, incidentsFound: 1, hoursLost: 0.25 }));

  expect(mine.question).toContain("1,453");
  expect(theirs.question).toContain("20");
  expect(theirs.question).not.toContain("1,453");
  expect(theirs.question).not.toContain("12 ");
});

test("a machine with no measured data never invents figures", () => {
  const rendered = renderGate("I1", gateValues({}));
  expect(rendered.question).not.toMatch(/\[/);
  expect(rendered.question).not.toContain("1,453");
  expect(rendered.question).not.toContain("6.5");
});

test("the runner renders gates with values instead of raw placeholders", () => {
  const runner = new OnboardingRunner({ gate: "I1", answers: {} }, {}, {}, gateValues({ sessionsScanned: 42, incidentsFound: 2, hoursLost: 1 }));
  expect(runner.current().question).toContain("42");
  expect(runner.current().question).not.toMatch(/\[/);
});
