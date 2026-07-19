import { expect, test } from "bun:test";
import { onboardingGateValues } from "../src/onboarding/gate-measurements";
import { renderGate } from "../src/onboarding/gates";
import type { OnboardingCheckpoint } from "../src/onboarding/coordinator";
import type { IncidentManifest } from "../src/ingest/rank";

function incident(overrides: Partial<IncidentManifest> = {}): IncidentManifest {
  return {
    incident_id: "git-stash-untracked", class: "A", chokepoint: "shell", command: "git stash -u",
    condition: "deleted untracked files", evidence_refs: ["s1:0"], severity: 5, frequency: 3,
    recency: "2026-07-15", ...overrides,
  };
}

function checkpoint(overrides: Partial<OnboardingCheckpoint> = {}): OnboardingCheckpoint {
  return {
    phase: "review", environmentConfirmed: true, consented: true, selectedSourceIds: ["claude-code"],
    incidentCount: 1, approvedIncidentIds: [], installedGuardIds: [], cancelled: false,
    incidents: [incident()], approved: [], installed: [],
    discovery: { environments: [{ id: "claude-code", label: "Claude Code" }], sources: [] },
    ...overrides,
  };
}

// This binding is the part that was broken before: the values existed but
// nothing supplied them on the live path.
test("the headline gate renders this machine's real figures", () => {
  const rendered = renderGate("I1", onboardingGateValues(checkpoint({ sessionsScanned: 312 })));
  expect(rendered.question).toContain("312 sessions");
  expect(rendered.question).toContain("1 mistake");
  expect(rendered.question).not.toMatch(/\[/);
  // 3 occurrences of a class-A incident at 30 minutes = 1.5 hours.
  expect(rendered.question).toContain("1.5 hours");
});

test("the reviewed incident quotes the real command, date, and effect", () => {
  const rendered = renderGate("J1", onboardingGateValues(checkpoint()));
  expect(rendered.question).toContain("git stash -u");
  expect(rendered.question).toContain("Jul 15");
  expect(rendered.question).toContain("destroyed work");
});

test("a non-destructive top incident does not claim files were destroyed", () => {
  const values = onboardingGateValues(checkpoint({
    incidents: [incident({ class: "C", command: "npm publish", incident_id: "npm-publish" })],
  }));
  const rendered = renderGate("J1", values);
  expect(rendered.question).toContain("npm publish");
  expect(rendered.question).not.toContain("destroyed work");
});

test("the scan option names the agent, never the detection mechanism", () => {
  const rendered = renderGate("F2", onboardingGateValues(checkpoint()));
  expect(rendered.options[0]).toContain("Claude Code");
  for (const mechanism of ["environment", "parent-process", "saved", "tty"]) {
    expect(rendered.options[0]).not.toContain(`through ${mechanism}`);
  }
});

test("an unscanned machine states no figures at all", () => {
  const values = onboardingGateValues(undefined);
  const rendered = renderGate("I1", values);
  expect(rendered.question).not.toMatch(/\d/);
  expect(rendered.question).not.toMatch(/\[/);
});

test("environments render as a readable list", () => {
  const values = onboardingGateValues(checkpoint({
    discovery: {
      environments: [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }, { id: "hermes", label: "Hermes" }],
      sources: [],
    },
  }));
  expect(renderGate("M", values).question).toContain("Claude Code, Codex and Hermes");
});
