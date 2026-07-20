import { expect, test } from "bun:test";
import { formatSessionsBySource } from "../src/onboarding/gate-measurements";
import { renderGate, gateValues } from "../src/onboarding/gates";

test("formatSessionsBySource renders a single source plainly", () => {
  expect(formatSessionsBySource({ "claude-code": 5 })).toBe("5 from Claude Code");
});

test("formatSessionsBySource joins multiple sources with ' + '", () => {
  expect(formatSessionsBySource({ "claude-code": 5, "hermes": 2 })).toBe("5 from Claude Code + 2 from Hermes");
});

test("formatSessionsBySource sorts by count desc", () => {
  expect(formatSessionsBySource({ "hermes": 1, "claude-code": 7, "codex": 3 })).toBe("7 from Claude Code + 3 from Codex + 1 from Hermes");
});

test("I1 gate renders the per-source breakdown when present (audit H3)", () => {
  const rendered = renderGate("I1", gateValues({
    sessionsBySource: "5 from Claude Code + 2 from Hermes",
    incidentsFound: 3,
  }));
  expect(rendered.question).toContain("5 from Claude Code + 2 from Hermes");
  expect(rendered.question).not.toMatch(/\[sessionsBySource\]/);
});

test("I1 gate falls back to sessionsScanned when per-source not provided", () => {
  const rendered = renderGate("I1", gateValues({ sessionsScanned: 312 }));
  expect(rendered.question).toContain("312");
  expect(rendered.question).not.toMatch(/\[sessionsBySource\]/);
});
