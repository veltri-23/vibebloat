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

test("R3 returns safe rule and firing evidence without inventing override counts", () => {
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

  const result = runReturningService("R3", {
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

test("R4 runs doctor and writes daily evidence without claiming an incremental scan", () => {
  const home = mkdtempSync(join(tmpdir(), "vibebloat-returning-r4-"));
  const result = runReturningService("R4", {
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
  });

  expect(result.kind).toBe("catch-up");
  if (result.kind !== "catch-up") throw new Error("Expected catch-up result.");
  expect(result.doctor).toEqual({ healthy: true, findings: [], auditWarnings: [] });
  expect(result.complete).toBeFalse();
  expect(result.incrementalScan).toEqual({ status: "blocked", reason: "No durable returning-scan cursor exists." });
  expect(result.daily.report.generatedAt).toBe("2026-07-18T14:00:00.000Z");
  expect(existsSync(result.daily.proposalPath)).toBeTrue();
});

test("R1 and R2 fail closed instead of rescanning all history", () => {
  const options = { globalHome: "unused", guards: [] };
  expect(() => runReturningService("R1", options)).toThrow("since-last-run problem scan is unavailable because no durable returning-scan cursor exists.");
  expect(() => runReturningService("R2", options)).toThrow("targeted project or tool scan is unavailable because no durable returning-scan cursor exists.");
});
