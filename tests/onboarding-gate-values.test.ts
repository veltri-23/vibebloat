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
    sessionsBySource: "5 from Claude Code + 2 from Hermes",
    sessionsScanned: 7,
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
  const mine = renderGate("I1", gateValues({ sessionsBySource: "1,453 from Claude Code", incidentsFound: 12, hoursLost: 6.5 }));
  const theirs = renderGate("I1", gateValues({ sessionsBySource: "20 from Hermes", incidentsFound: 1, hoursLost: 0.25 }));

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

test("an option answered with its displayed text still advances the gate", () => {
  // The runner displays RENDERED options; matching them against raw gate text
  // silently reinterprets the answer as an assist question and sticks the flow.
  const values = gateValues({ runnerAgent: "Claude Code" });
  const runner = new OnboardingRunner({ gate: "F2", answers: {} }, {}, {}, values);
  const displayed = runner.current().options[0]!;
  expect(displayed).toContain("Claude Code");

  runner.choose(displayed);
  expect(runner.snapshot().gate).not.toBe("F2");
  expect(runner.snapshot().answers.F2).toBeDefined();
});

test("the incident effect matches what the incident actually did", () => {
  const destructive = renderGate("J1", gateValues({ topIncidentCommand: "git stash -u", incidentClass: "A" }));
  expect(destructive.question).toContain("git stash -u");

  // A non-destructive incident must not claim it deleted files.
  const config = renderGate("J1", gateValues({ topIncidentCommand: "npm publish", incidentClass: "B" }));
  expect(config.question).not.toContain("wiped out some of your files");
  expect(config.question).not.toContain("deleted");
});

test("unmeasured fallbacks do not produce broken sentences", () => {
  const j0 = renderGate("J0", gateValues({})).question;
  expect(j0).not.toContain("the the");

  // An empty quote renders as '' and reads as a bug.
  const unsure = renderGate("J1-unsure", gateValues({})).question;
  expect(unsure).not.toContain("''");

  const stale = renderGate("D1.1", gateValues({})).question;
  expect(stale[0]).toBe(stale[0]!.toUpperCase());
});
