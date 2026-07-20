import { expect, test } from "bun:test";
import { compileGuard, compileRankedIncidents } from "../src/compiler/codex-fill";
import { renderGuardReceipt } from "../src/block-receipt";
import { match } from "../src/match";
import { syntheticEvent } from "../src/compiler/synthetic-event";
import { assertSafeIncident } from "../src/onboarding/coordinator";
import type { IncidentManifest } from "../src/ingest/rank";

const stashIncident: IncidentManifest = {
  incident_id: "git-stash-untracked",
  class: "A",
  chokepoint: "shell",
  command: "git stash",
  args_contains: ["-u"],
  condition: "git stash -u deleted operational untracked files",
  remediation: "Use git stash -u -- <path> or commit first.",
  evidence_refs: ["s1:0"],
  severity: 5,
  frequency: 3,
  recency: "2026-07-15",
};

test("a mined guard blocks the dangerous form, not the whole command", () => {
  const guard = compileGuard(stashIncident, "high");
  // A single flag widens to every spelling of the same operation.
  expect(guard.match.argsAnyOf).toEqual(["-u", "--include-untracked"]);
  expect(match(guard, { chokepoint: "shell", command: "git stash --include-untracked" }).fired).toBe(true);

  // The incident: destructive.
  expect(match(guard, { chokepoint: "shell", command: "git stash -u" }).fired).toBe(true);
  // Ordinary safe usage must keep working, or the guard is worse than nothing.
  expect(match(guard, { chokepoint: "shell", command: "git stash" }).fired).toBe(false);
  expect(match(guard, { chokepoint: "shell", command: "git stash pop" }).fired).toBe(false);
});

test("the mined message tells the user what happened and what to do", () => {
  const guard = compileGuard(stashIncident, "high");
  expect(guard.action.message).toContain("deleted operational untracked files");
  expect(guard.action.message).toContain("Use git stash -u -- <path> or commit first.");
  // The useless placeholder the compiler used to emit.
  expect(guard.action.message).not.toContain("VibeBloat found");
});

test("a mined guard renders the receipt the README advertises", () => {
  const guard = compileGuard(stashIncident, "high");
  const receipt = renderGuardReceipt(guard, guard.action.message)!;
  const lines = receipt.split("\n");

  expect(lines[0]).toContain("BLOCKED");
  expect(lines[0]).toContain("guard: git-stash-untracked");
  expect(lines[0]).toContain("class: A");
  expect(lines[1]).toContain("incident: git stash -u deleted operational untracked files");
  expect(lines[1]).toContain("date: 2026-07-15");
  expect(lines[2]).toContain("Use git stash -u -- <path> or commit first.");
  expect(lines[3]).toBe("fix: vibebloat allow git-stash-untracked --once");
});

test("an incident with no remediation still explains itself", () => {
  const guard = compileGuard({ ...stashIncident, remediation: undefined }, "high");
  expect(guard.action.message).toContain("deleted operational untracked files");
  expect(guard.action.message).not.toContain("undefined");
});

test("an incident with no args still compiles to a command-level guard", () => {
  const guard = compileGuard({ ...stashIncident, args_contains: undefined, command: "rm -rf" }, "high");
  expect(guard.match.argsContains).toBeUndefined();
  expect(match(guard, { chokepoint: "shell", command: "rm -rf /tmp/x" }).fired).toBe(true);
});

test("a guard requiring args can prove itself at compile time", () => {
  const guard = compileGuard(stashIncident, "high");
  const event = syntheticEvent(guard);
  // Built from the bare command, an args-scoped guard fails its own proof and
  // is rejected before it can ever be installed.
  expect(event.command).toContain("-u");
  expect(match(guard, event).fired).toBe(true);
});

test("an over-long or malformed args list is rejected, never silently dropped", () => {
  // Dropping the field reverts the guard to a bare-command match, which is the
  // "blocks every git stash" bug this whole change exists to remove.
  const tooMany = { ...stashIncident, args_contains: Array.from({ length: 20 }, () => "-u") };
  expect(() => assertSafeIncident(tooMany)).toThrow();

  const tooLong = { ...stashIncident, args_contains: ["-".repeat(200)] };
  expect(() => assertSafeIncident(tooLong)).toThrow();

  const notStrings = { ...stashIncident, args_contains: [42] as unknown as string[] };
  expect(() => assertSafeIncident(notStrings)).toThrow();

  const longRemediation = { ...stashIncident, remediation: "x".repeat(500) };
  expect(() => assertSafeIncident(longRemediation)).toThrow();

  expect(() => assertSafeIncident(stashIncident)).not.toThrow();
});

test("duplicate incidents from one model response collapse to one guard", () => {
  // A local model returned the same incident three times on real data; three
  // identical guards would install, each firing on the same command.
  const duplicated = [stashIncident, { ...stashIncident }, { ...stashIncident, frequency: 9 }];
  const guards = compileRankedIncidents(duplicated);
  expect(guards).toHaveLength(1);
  // The highest-frequency copy wins, since ranking already prefers it.
  expect(guards[0]!.id).toBe("git-stash-untracked");
});

test("distinct incidents are all kept", () => {
  const guards = compileRankedIncidents([
    stashIncident,
    { ...stashIncident, incident_id: "docker-volumes", command: "docker compose", args_contains: ["down", "-v"] },
  ]);
  expect(guards).toHaveLength(2);
});
