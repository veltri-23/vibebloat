import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGuards } from "../src/guard-loader";
import { parseGuard } from "../src/schema";

const validGuard = {
  id: "git-stash-u",
  class: "A",
  provenance: { incident: "test", date: "2026-07-17", source: "test" },
  match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
  action: { type: "block", message: "stop", override: "vibebloat allow git-stash-u --once" },
  confidence: "high",
  tier: "local",
  enabled: true,
  binds: ["claude-code", "codex"],
};

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("guard schema", () => {
  test("accepts declarative guards using trusted actions only", () => {
    expect(parseGuard(validGuard)).toEqual(validGuard);
  });

  test("rejects unknown action types and executable payloads", () => {
    expect(() => parseGuard({ ...validGuard, action: { ...validGuard.action, type: "shell-script", command: "rm -rf /" } })).toThrow();
  });

  test("rejects unknown agent bindings", () => {
    expect(() => parseGuard({ ...validGuard, binds: ["unknown-agent"] })).toThrow("binds must contain known agents");
    expect(() => parseGuard({ ...validGuard, binds: null })).toThrow("binds must contain known agents");
  });

  test("loads only validated JSON guards before the hot path", () => {
    const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-guards-"));
    tempDirectories.push(directory);
    writeFileSync(join(directory, "guard.json"), JSON.stringify(validGuard));
    expect(loadGuards(directory)).toEqual([validGuard]);
  });
});
