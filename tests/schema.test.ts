import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadGuards } from "../src/guard-loader";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";
import { match } from "../src/match";
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

  test("treats missing schema version and explicit v1 identically", () => {
    const implicit = parseGuard(validGuard);
    const explicit = parseGuard({ ...validGuard, schemaVersion: 1 });
    const event = { chokepoint: "shell" as const, command: "git stash -u" };
    expect(implicit.schemaVersion ?? 1).toBe(explicit.schemaVersion);
    expect(match(implicit, event)).toEqual(match(explicit, event));
  });

  test("rejects unsupported schema versions", () => {
    for (const schemaVersion of [0, 2, "1", null]) {
      expect(() => parseGuard({ ...validGuard, schemaVersion })).toThrow("schemaVersion must be 1");
    }
  });

  test("rejects unknown fields at every closed schema level", () => {
    expect(() => parseGuard({ ...validGuard, executable: "payload" })).toThrow("top-level guard contains unknown field executable");
    expect(() => parseGuard({ ...validGuard, provenance: { ...validGuard.provenance, transcript: "raw" } })).toThrow("provenance contains unknown field transcript");
    expect(() => parseGuard({ ...validGuard, match: { ...validGuard.match, condition: "always" } })).toThrow("match contains unknown field condition");
    expect(() => parseGuard({ ...validGuard, action: { ...validGuard.action, script: "run me" } })).toThrow("action contains unknown field script");
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

  test("loads current built-in and community-compatible guard shapes", () => {
    const communityGuard = { ...validGuard, id: "community-stash", tier: "community" };
    expect([gitStashUntrackedGuard, mcpConfigWrongFileGuard, validGuard, communityGuard].map(parseGuard)).toEqual([
      gitStashUntrackedGuard,
      mcpConfigWrongFileGuard,
      validGuard,
      communityGuard,
    ]);
  });

  test("eval rejects unsupported schema before matching", () => {
    const result = Bun.spawnSync(["bun", "src/cli.ts", "eval"], {
      cwd: import.meta.dir + "/..",
      stdin: new TextEncoder().encode(JSON.stringify({
        guard: { ...validGuard, schemaVersion: 2 },
        event: { chokepoint: "shell", command: "git stash -u" },
      })),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("schemaVersion must be 1");
  });
});
