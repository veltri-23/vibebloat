import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileGuard } from "../src/compiler/codex-fill";
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

  test("rejects malformed identifiers and provenance values", () => {
    for (const id of ["", "two words", "Upper-Case", "under_score", 7]) {
      expect(() => parseGuard({ ...validGuard, id })).toThrow("id must use lower-case kebab-case");
    }
    for (const field of ["incident", "date", "source"] as const) {
      expect(() => parseGuard({ ...validGuard, provenance: { ...validGuard.provenance, [field]: " " } })).toThrow(`provenance.${field} must be a non-empty string`);
      expect(() => parseGuard({ ...validGuard, provenance: { ...validGuard.provenance, [field]: { payload: true } } })).toThrow(`provenance.${field} must be a non-empty string`);
    }
  });

  test("rejects malformed match fields and argument arrays", () => {
    expect(() => parseGuard({ ...validGuard, match: { chokepoint: "shell" } })).toThrow("shell match requires a non-empty command");
    expect(() => parseGuard({ ...validGuard, match: { chokepoint: "file" } })).toThrow("file match requires a non-empty path");
    expect(() => parseGuard({ ...validGuard, match: { chokepoint: "shell", command: " " } })).toThrow("match.command must be a non-empty string");
    expect(() => parseGuard({ ...validGuard, match: { chokepoint: "file", path: "" } })).toThrow("match.path must be a non-empty string");
    expect(() => parseGuard({ ...validGuard, match: { chokepoint: "shell", command: 42 } })).toThrow("match.command must be a non-empty string");
    expect(() => parseGuard({ ...validGuard, match: { chokepoint: "file", path: { payload: true } } })).toThrow("match.path must be a non-empty string");
    for (const field of ["argsContains", "argsAnyOf"] as const) {
      expect(() => parseGuard({ ...validGuard, match: { ...validGuard.match, [field]: "-u" } })).toThrow(`match.${field} must be an array of non-empty strings`);
      expect(() => parseGuard({ ...validGuard, match: { ...validGuard.match, [field]: ["-u", " "] } })).toThrow(`match.${field} must be an array of non-empty strings`);
      expect(() => parseGuard({ ...validGuard, match: { ...validGuard.match, [field]: ["-u", { payload: true }] } })).toThrow(`match.${field} must be an array of non-empty strings`);
    }
  });

  test("rejects malformed action fields", () => {
    for (const field of ["message", "override"] as const) {
      expect(() => parseGuard({ ...validGuard, action: { ...validGuard.action, [field]: " " } })).toThrow(`action.${field} must be a non-empty string`);
      expect(() => parseGuard({ ...validGuard, action: { ...validGuard.action, [field]: { payload: true } } })).toThrow(`action.${field} must be a non-empty string`);
    }
    expect(() => parseGuard({ ...validGuard, action: { type: "quarantine-file", message: "move", override: "allow" } })).toThrow("quarantine-file requires a non-empty quarantinePath");
    expect(() => parseGuard({ ...validGuard, action: { type: "quarantine-file", message: "move", override: "allow", quarantinePath: [] } })).toThrow("quarantine-file requires a non-empty quarantinePath");
    expect(() => parseGuard({ ...validGuard, action: { type: "run-check", message: "check", override: "allow" } })).toThrow("run-check requires a non-empty check name");
    expect(() => parseGuard({ ...validGuard, action: { type: "run-check", message: "check", override: "allow", check: " " } })).toThrow("run-check requires a non-empty check name");
    expect(() => parseGuard({ ...validGuard, action: { type: "run-check", message: "check", override: "allow", check: { payload: true } } })).toThrow("run-check requires a non-empty check name");
  });

  test("rejects malformed confidence, tier, and binds", () => {
    for (const confidence of ["medium", "", 1, null]) {
      expect(() => parseGuard({ ...validGuard, confidence })).toThrow("confidence must be high or low");
    }
    for (const tier of ["remote", "", 1, null]) {
      expect(() => parseGuard({ ...validGuard, tier })).toThrow("tier must be local or community");
    }
    expect(() => parseGuard({ ...validGuard, binds: "codex" })).toThrow("binds must be an array of known agents");
    expect(() => parseGuard({ ...validGuard, binds: ["codex", { payload: true }] })).toThrow("binds must be an array of known agents");
    expect(() => parseGuard({ ...validGuard, binds: ["codex", "codex"] })).toThrow("binds must not contain duplicates");
    expect(parseGuard({ ...validGuard, binds: [] })).toEqual({ ...validGuard, binds: [] });
  });

  test("rejects unknown agent bindings", () => {
    expect(() => parseGuard({ ...validGuard, binds: ["unknown-agent"] })).toThrow("binds must be an array of known agents");
    expect(() => parseGuard({ ...validGuard, binds: null })).toThrow("binds must be an array of known agents");
  });

  test("loads only validated JSON guards before the hot path", () => {
    const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-guards-"));
    tempDirectories.push(directory);
    writeFileSync(join(directory, "guard.json"), JSON.stringify(validGuard));
    expect(loadGuards(directory)).toEqual([validGuard]);
  });

  test("loads current built-in and community-compatible guard shapes", () => {
    const communityGuard = { ...validGuard, id: "community-stash", tier: "community" };
    const compiledGuard = compileGuard({
      incident_id: "compiled-stash",
      class: "A",
      chokepoint: "shell",
      command: "git stash",
      condition: "untracked files present",
      evidence_refs: ["claude-code:test:1:0"],
      severity: 5,
      frequency: 2,
      recency: "2026-07-18",
    }, "high");
    expect([gitStashUntrackedGuard, mcpConfigWrongFileGuard, compiledGuard, communityGuard].map(parseGuard)).toEqual([
      gitStashUntrackedGuard,
      mcpConfigWrongFileGuard,
      compiledGuard,
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
