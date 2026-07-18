import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFiring } from "../../src/audit/firings";
import { runReturningService } from "../../src/onboarding/returning-service";
import type { Guard } from "../../src/types";

function guard(id: string): Guard {
  return {
    id,
    class: "A",
    provenance: { incident: "test", date: "2026-07-18", source: "local" },
    match: { chokepoint: "shell", command: id },
    action: { type: "block", message: "blocked", override: "vibebloat allow-once" },
    enabled: true,
  };
}

test("R3 returns safe rule and firing evidence without inventing override counts", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibebloat-returning-r3-"));
  const first = guard("alpha-rule");
  const second = guard("beta-rule");
  appendFiring(home, true, {
    guardId: first.id,
    class: first.class,
    chokepoint: first.match.chokepoint,
    actionType: first.action.type,
    blocked: true,
  }, new Date("2026-07-18T12:00:00.000Z"));
  appendFiring(home, true, {
    guardId: first.id,
    class: first.class,
    chokepoint: first.match.chokepoint,
    actionType: first.action.type,
    blocked: true,
  }, new Date("2026-07-18T13:00:00.000Z"));

  const result = await runReturningService("R3", {
    globalHome: home,
    guards: [second, first],
    disabledGuardIds: [second.id],
    now: new Date("2026-07-18T14:00:00.000Z"),
  });

  expect(result.kind).toBe("manage-rules");
  if (result.kind !== "manage-rules") throw new Error("Expected manage-rules result.");
  expect(result.rules.map(({ id, enabled, firingCount, lastFiredAt }) => ({ id, enabled, firingCount, lastFiredAt }))).toEqual([
    { id: "alpha-rule", enabled: true, firingCount: 2, lastFiredAt: "2026-07-18T13:00:00.000Z" },
    { id: "beta-rule", enabled: false, firingCount: 0, lastFiredAt: null },
  ]);
  expect(result.mostOverridden).toBeNull();
  expect(result.limitations).toEqual(["Historical override counts are not recorded."]);
});

test("R4 runs doctor, writes daily evidence, and reports its incremental scan", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibebloat-returning-r4-"));
  const result = await runReturningService("R4", {
    globalHome: home,
    guards: [],
    now: new Date("2026-07-18T14:00:00.000Z"),
    doctorOptions: {
      requireProof: false,
      guards: [],
      hookConfigs: {
        claude: "vibebloat",
        codex: "vibebloat\nplugin_hooks = true",
      },
    },
    dailyOptions: {
      environment: { VIBEBLOAT_HOME: home, USERPROFILE: home },
      cwd: home,
    },
    incrementalScan: async () => ({ status: "ingested", chunksScanned: 2, incidentsFound: 1 }),
  });

  expect(result.kind).toBe("catch-up");
  if (result.kind !== "catch-up") throw new Error("Expected catch-up result.");
  expect(result.doctor).toEqual({ healthy: true, findings: [], auditWarnings: [] });
  expect(result.complete).toBeTrue();
  expect(result.incrementalScan).toEqual({ status: "ingested", chunksScanned: 2, incidentsFound: 1 });
  expect(result.daily.report.generatedAt).toBe("2026-07-18T14:00:00.000Z");
  expect(existsSync(result.daily.proposalPath)).toBeTrue();
});

test("R1, R2, and R4 invoke the configured bounded returning scan", async () => {
  const home = mkdtempSync(join(tmpdir(), "vibebloat-returning-scan-"));
  const options = { globalHome: home, guards: [] };
  const calls: string[] = [];
  const configured = {
    ...options,
    doctorOptions: { requireProof: false, guards: [], hookConfigs: { claude: "vibebloat", codex: "vibebloat\nplugin_hooks = true" } },
    dailyOptions: { environment: { VIBEBLOAT_HOME: home, USERPROFILE: home }, cwd: home },
    incrementalScan: async (gate: "R1" | "R2" | "R4") => {
      calls.push(gate);
      return { status: "ingested" as const, chunksScanned: 0, incidentsFound: 0 };
    },
  };
  await expect(runReturningService("R1", configured)).resolves.toMatchObject({ kind: "scan-problem", compareExistingRules: true });
  await expect(runReturningService("R2", configured)).resolves.toMatchObject({ kind: "discover-project-or-tool", scopedRules: true });
  await expect(runReturningService("R4", configured)).resolves.toMatchObject({ kind: "catch-up", complete: true });
  expect(calls).toEqual(["R1", "R2", "R4"]);
});

test("R1 fails closed when the durable cursor scanner is unavailable", async () => {
  await expect(runReturningService("R1", { globalHome: "unused", guards: [] }))
    .rejects.toThrow("Returning scan is unavailable because no durable returning-scan cursor is configured.");
});
