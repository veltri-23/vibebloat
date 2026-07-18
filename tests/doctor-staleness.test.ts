import { expect, test } from "bun:test";
import { assessGuardStaleness } from "../src/doctor/staleness";

const now = new Date("2026-07-18T12:00:00.000Z");

test("a guard fired within ninety days and with matching upstream version stays affirmed", () => {
  expect(assessGuardStaleness({
    lastFiredAt: "2026-04-19T12:00:00.001Z",
    installedUpstreamVersion: "1.4.0",
    currentUpstreamVersion: "1.4.0",
    now,
  })).toEqual({ needsReaffirmation: false, reasons: [] });
});

test("no firing for exactly ninety days needs reaffirmation", () => {
  expect(assessGuardStaleness({
    lastFiredAt: "2026-04-19T12:00:00.000Z",
    now,
  })).toEqual({ needsReaffirmation: true, reasons: ["no-fire-in-90-days"] });
});

test("supplied upstream version drift needs reaffirmation even after a recent firing", () => {
  expect(assessGuardStaleness({
    lastFiredAt: "2026-07-17T12:00:00.000Z",
    installedUpstreamVersion: "1.4.0",
    currentUpstreamVersion: "1.5.0",
    now,
  })).toEqual({ needsReaffirmation: true, reasons: ["upstream-version-drift"] });
});

test("missing and malformed firing timestamps are conservative and explain why", () => {
  expect(assessGuardStaleness({ now })).toEqual({ needsReaffirmation: true, reasons: ["last-fired-at-missing"] });
  expect(assessGuardStaleness({ lastFiredAt: "not-a-timestamp", now })).toEqual({ needsReaffirmation: true, reasons: ["last-fired-at-invalid"] });
  expect(assessGuardStaleness({ lastFiredAt: "2026-07-19T12:00:00.000Z", now })).toEqual({ needsReaffirmation: true, reasons: ["last-fired-at-future"] });
});

test("an invalid injected clock is conservative instead of depending on wall time", () => {
  expect(assessGuardStaleness({
    lastFiredAt: "2026-07-17T12:00:00.000Z",
    now: new Date("invalid"),
  })).toEqual({ needsReaffirmation: true, reasons: ["current-time-invalid"] });
});
