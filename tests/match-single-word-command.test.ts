import { expect, test } from "bun:test";
import { compileGuard } from "../src/compiler/codex-fill";
import { syntheticEvent } from "../src/compiler/synthetic-event";
import { match } from "../src/match";
import type { IncidentManifest } from "../src/ingest/rank";

function incident(overrides: Partial<IncidentManifest>): IncidentManifest {
  return {
    incident_id: "i", class: "C", chokepoint: "shell", command: "grep", args_contains: ["-r"],
    condition: "c", remediation: "r", evidence_refs: [], severity: 2, frequency: 3,
    recency: "2026-07-15", ...overrides,
  };
}

// Real mining produces bare-binary commands (grep, python, npx, cat). The
// matcher required a subcommand, so a third of the guards mined from real
// history could never fire — and failed their own compile-time proof.
test("a guard on a bare binary fires", () => {
  const guard = compileGuard(incident({}), "low");
  expect(match(guard, { chokepoint: "shell", command: "grep -r pattern src" }).fired).toBe(true);
  expect(match(guard, syntheticEvent(guard)).fired).toBe(true);
});

test("a bare-binary guard still respects its argument scope", () => {
  const guard = compileGuard(incident({}), "low");
  // No -r: not the incident.
  expect(match(guard, { chokepoint: "shell", command: "grep pattern file" }).fired).toBe(false);
});

test("bare binaries with no arguments at all match the binary", () => {
  const guard = compileGuard(incident({ command: "python", args_contains: undefined }), "low");
  expect(match(guard, { chokepoint: "shell", command: "python script.py" }).fired).toBe(true);
  expect(match(guard, { chokepoint: "shell", command: "python3 script.py" }).fired).toBe(false);
});

test("subcommand guards keep their existing precision", () => {
  const guard = compileGuard(incident({ command: "git stash", args_contains: ["-u"], class: "A" }), "high");
  expect(match(guard, { chokepoint: "shell", command: "git stash -u" }).fired).toBe(true);
  expect(match(guard, { chokepoint: "shell", command: "git stash" }).fired).toBe(false);
  expect(match(guard, { chokepoint: "shell", command: "git pull" }).fired).toBe(false);
});
