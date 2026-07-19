import { expect, test } from "bun:test";
import { compileGuard } from "../src/compiler/codex-fill";
import { renderGuardReceipt } from "../src/block-receipt";
import { match } from "../src/match";
import { syntheticEvent } from "../src/compiler/synthetic-event";
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
  expect(guard.match.argsContains).toEqual(["-u"]);

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
