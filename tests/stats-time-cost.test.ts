import { expect, test } from "bun:test";
import { estimatedHoursLost, RECOVERY_MINUTES_BY_CLASS } from "../src/stats/time-cost";
import type { IncidentManifest } from "../src/ingest/rank";

function incident(overrides: Partial<IncidentManifest>): IncidentManifest {
  return {
    incident_id: "i", class: "A", chokepoint: "shell", command: "git stash -u",
    condition: "c", evidence_refs: [], severity: 5, frequency: 1, recency: "2026-07-15",
    ...overrides,
  };
}

test("cost scales with how often each incident actually hit", () => {
  const once = estimatedHoursLost([incident({ frequency: 1 })]);
  const tenTimes = estimatedHoursLost([incident({ frequency: 10 })]);
  expect(tenTimes).toBeCloseTo(once * 10, 5);
});

test("destructive incidents are costed higher than logic ones", () => {
  expect(RECOVERY_MINUTES_BY_CLASS.A).toBeGreaterThan(RECOVERY_MINUTES_BY_CLASS.D);
  expect(RECOVERY_MINUTES_BY_CLASS.D).toBeGreaterThan(RECOVERY_MINUTES_BY_CLASS.C);
});

test("uses the documented per-class rate", () => {
  // 2 destructive incidents at 30 minutes each = 1 hour.
  expect(estimatedHoursLost([incident({ class: "A", frequency: 2 })])).toBeCloseTo(2 * RECOVERY_MINUTES_BY_CLASS.A / 60, 5);
});

test("sums across incidents of different classes", () => {
  const total = estimatedHoursLost([
    incident({ class: "A", frequency: 2 }),
    incident({ class: "C", frequency: 3 }),
  ]);
  expect(total).toBeCloseTo((2 * RECOVERY_MINUTES_BY_CLASS.A + 3 * RECOVERY_MINUTES_BY_CLASS.C) / 60, 5);
});

test("no incidents means no claim", () => {
  expect(estimatedHoursLost([])).toBeUndefined();
});

test("a zero or negative frequency never subtracts from the estimate", () => {
  expect(estimatedHoursLost([incident({ frequency: 0 })])).toBeUndefined();
  expect(estimatedHoursLost([incident({ frequency: -5 })])).toBeUndefined();
});
