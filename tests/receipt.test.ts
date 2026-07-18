import { expect, test } from "bun:test";
import { aggregateShareableReceipt, weeklyReceiptWindow } from "../src/growth/receipt";

const window = weeklyReceiptWindow(new Date("2026-07-18T12:00:00.000Z"));

test("receipt aggregation requires an explicit opt-in", () => {
  expect(aggregateShareableReceipt(
    { mode: "local-only" },
    window,
    [{ category: "A", occurredAt: "2026-07-17T12:00:00.000Z" }],
  )).toBeUndefined();
});

test("receipt payload contains only weekly category counts and its timestamp window", () => {
  const receipt = aggregateShareableReceipt(
    { mode: "opted-in" },
    window,
    [
      { category: "A", occurredAt: "2026-07-11T12:00:00.000Z" },
      { category: "A", occurredAt: "2026-07-17T12:00:00.000Z" },
      { category: "B", occurredAt: "2026-07-17T12:00:00.000Z" },
      { category: "C", occurredAt: "2026-07-18T12:00:00.000Z" },
      { category: "D", occurredAt: "2026-07-10T12:00:00.000Z" },
    ],
  );

  expect(receipt).toEqual({
    window: { startsAt: "2026-07-11T12:00:00.000Z", endsAt: "2026-07-18T12:00:00.000Z" },
    counts: { A: 2, B: 1, C: 0, D: 0 },
  });
});

test("receipt aggregation cannot carry command, secret, identity, or path input", () => {
  const privateObservation = {
    category: "A" as const,
    occurredAt: "2026-07-17T12:00:00.000Z",
    command: "git stash -u -- C:\\Users\\hunter\\private",
    path: "C:\\Users\\hunter\\private",
    guardId: "git-stash-u",
    userId: "hunter",
    machineId: "desktop-01",
    token: "Bearer super-secret-token",
  };
  const receipt = aggregateShareableReceipt({ mode: "opted-in" }, window, [privateObservation]);
  const serialized = JSON.stringify(receipt);

  expect(receipt).toEqual({
    window: { startsAt: "2026-07-11T12:00:00.000Z", endsAt: "2026-07-18T12:00:00.000Z" },
    counts: { A: 1, B: 0, C: 0, D: 0 },
  });
  for (const forbidden of [
    "git stash -u",
    "C:\\Users\\hunter\\private",
    "git-stash-u",
    "hunter",
    "desktop-01",
    "Bearer super-secret-token",
  ]) expect(serialized).not.toContain(forbidden);
});
