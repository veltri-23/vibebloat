import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each([
  ["O1", undefined],
  ["O2", {
    phase: "complete",
    scope: "repo",
    environmentConfirmed: true,
    consented: true,
    selectedSourceIds: [],
    incidentCount: 0,
    approvedIncidentIds: [],
    installedGuardIds: [],
    cancelled: false,
    discovery: { environments: [{ id: "hermes", label: "Hermes" }], sources: [] },
    incidents: [],
    approved: [],
    installed: [],
  }],
] as const)("%s rejects a source checkout rather than scheduling Bun with an incomplete command", (gate, coordinator) => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-onboarding-daily-"));
  roots.push(root);
  const repository = join(root, "repo");
  const home = join(root, "state");
  mkdirSync(repository);
  mkdirSync(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate, scope: "repo", answers: {}, ...(coordinator ? { coordinator } : {}) }));

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli.ts"), "init", "--human", "--answer", "Yes"], {
    cwd: repository,
    env: { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: root, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe(
    "WHAT failed: onboarding effect was not activated.\n" +
    `WHY: ${gate} requires a verified standalone VibeBloat executable and a verified native scheduler receipt.\n` +
    "FIX: install a signed VibeBloat release, then rerun vibebloat init\n",
  );
  expect(existsSync(join(home, "receipts", "daily-scheduler.json"))).toBeFalse();
});
