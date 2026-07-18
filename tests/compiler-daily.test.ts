import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDailyStrengthening, type DailyEvidence } from "../src/compiler/daily";
import type { Guard } from "../src/types";

const roots: string[] = [];
const now = new Date("2026-07-18T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-daily-"));
  roots.push(root);
  mkdirSync(join(root, "guards"), { recursive: true });
  return root;
}

function guard(id: string, incident = "local incident"): Guard {
  return {
    schemaVersion: 1,
    id,
    class: "A",
    provenance: { incident, date: "2026-07-17", source: "local" },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action: { type: "block", message: "Use scoped stash.", override: `vibebloat allow ${id} --once` },
    confidence: "high",
    binds: [],
    enabled: true,
  };
}

function installGuard(root: string, value: Guard): string {
  const path = join(root, "guards", `${value.id}.json`);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

test("daily pass proposes from local evidence without changing active guards", () => {
  const root = home();
  const activePath = installGuard(root, guard("active-guard", "Bearer raw-secret"));
  const recent = new Date("2026-07-18T11:00:00.000Z");
  utimesSync(activePath, recent, recent);
  const before = readFileSync(activePath, "utf8");
  const evidence: DailyEvidence[] = [
    { kind: "compiler-issue", guardId: "active-guard" },
    { kind: "incident", candidateGuard: guard("new-guard", "C:\\private\\source.ts") },
  ];

  const result = runDailyStrengthening({ home: root, evidence, now });

  expect(result.proposals).toEqual([
    { type: "refresh-profile", reason: "profile-missing" },
    { type: "prove-guards", reason: "proof-missing" },
    { type: "create-guard", guardId: "new-guard", guardClass: "A", actionType: "block", reason: "candidate-not-installed" },
    { type: "repair-guard", guardId: "active-guard", reason: "compiler-issue" },
  ]);
  expect(readFileSync(activePath, "utf8")).toBe(before);
  expect(JSON.stringify(result)).not.toContain(root);
  expect(JSON.stringify(result)).not.toContain("raw-secret");
  expect(JSON.stringify(result)).not.toContain("private");
});

test("daily pass uses installed and audit timestamps for exact ninety-day staleness", () => {
  const root = home();
  const guardPath = installGuard(root, guard("stale-guard"));
  writeFileSync(join(root, "profile.md"), "Local profile\n");
  writeFileSync(join(root, "guards", "proof.json"), JSON.stringify({ status: "pass", cases: [] }));
  const old = new Date("2026-04-19T12:00:00.000Z");
  utimesSync(guardPath, old, old);
  utimesSync(join(root, "profile.md"), old, old);
  const auditDirectory = join(root, "audit", "last-fired");
  mkdirSync(auditDirectory, { recursive: true });
  writeFileSync(join(auditDirectory, "stale-guard.json"), `${JSON.stringify({ schemaVersion: 1, guardId: "stale-guard", lastFiredAt: old.toISOString() })}\n`);

  expect(runDailyStrengthening({ home: root, now }).proposals).toEqual([
    { type: "refresh-profile", reason: "profile-stale" },
    { type: "reaffirm-guard", guardId: "stale-guard", reason: "no-fire-in-90-days" },
  ]);
});

test("recent install keeps a never-fired guard affirmed", () => {
  const root = home();
  const guardPath = installGuard(root, guard("fresh-guard"));
  writeFileSync(join(root, "profile.md"), "Local profile\n");
  writeFileSync(join(root, "guards", "proof.json"), "{}\n");
  const recent = new Date("2026-07-18T11:00:00.000Z");
  utimesSync(guardPath, recent, recent);

  expect(runDailyStrengthening({ home: root, now }).proposals).toEqual([]);
});

test("orphaned audit evidence proposes restoring missing guard", () => {
  const root = home();
  writeFileSync(join(root, "profile.md"), "Local profile\n");
  const auditDirectory = join(root, "audit", "last-fired");
  mkdirSync(auditDirectory, { recursive: true });
  writeFileSync(join(auditDirectory, "missing-guard.json"), `${JSON.stringify({ schemaVersion: 1, guardId: "missing-guard", lastFiredAt: "2026-07-17T12:00:00.000Z" })}\n`);

  expect(runDailyStrengthening({ home: root, now }).proposals).toEqual([
    { type: "restore-guard", guardId: "missing-guard", reason: "audit-without-guard" },
  ]);
});

test("daily output is sorted, bounded, and rejects unsafe evidence", () => {
  const root = home();
  writeFileSync(join(root, "profile.md"), "Local profile\n");
  const evidence: DailyEvidence[] = [
    { kind: "incident", candidateGuard: guard("z-guard") },
    { kind: "incident", candidateGuard: guard("a-guard") },
    { kind: "compiler-issue", guardId: "C:\\secret\\guard" },
    { kind: "unknown" as "incident", guardId: "unsafe-guard" },
    { kind: "incident", candidateGuard: guard("m-guard") },
  ];

  const result = runDailyStrengthening({ home: root, evidence, now, proposalLimit: 2 });

  expect(result.proposals.map((proposal) => proposal.guardId)).toEqual(["a-guard", "m-guard"]);
  expect(result.warnings).toEqual(["invalid-evidence"]);
  expect(JSON.stringify(result)).not.toContain("secret");
});
