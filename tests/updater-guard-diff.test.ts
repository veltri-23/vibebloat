import { expect, test } from "bun:test";
import { diffCommunityGuards, formatGuardDiff } from "../src/updater/guard-diff";
import type { Guard } from "../src/types";

function guard(id: string, overrides: Partial<Guard> = {}): Guard {
  return {
    id,
    class: "A",
    provenance: { incident: "scrubbed", date: "2026-07-18", source: "community" },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action: { type: "block", message: "stop", override: `vibebloat allow ${id} --once` },
    confidence: "high",
    tier: "community",
    binds: ["claude-code", "codex"],
    enabled: true,
    ...overrides,
  };
}

test("diff reports every executable guard change and ignores metadata-only changes", () => {
  const current = [guard("changed"), guard("removed"), guard("metadata")];
  const candidate = [
    guard("added"),
    guard("changed", { action: { type: "warn", message: "warn", override: "vibebloat allow changed --once" }, binds: ["hermes"] }),
    guard("metadata", { confidence: "low", provenance: { incident: "new summary", date: "2026-07-19", source: "community" } }),
  ];

  expect(diffCommunityGuards(current, candidate)).toEqual({
    added: ["added"],
    changed: [{ id: "changed", fields: ["action", "binds"] }],
    removed: ["removed"],
  });
});

test("preview prints exact counts, IDs, fields, and one apply command", () => {
  const preview = formatGuardDiff("0.4.0", "0.5.0", {
    added: ["new-guard"],
    changed: [{ id: "changed-guard", fields: ["match", "action"] }],
    removed: [],
  });

  expect(preview).toBe([
    "VibeBloat update available: 0.4.0 -> 0.5.0",
    "Guards: 1 added / 1 changed / 0 removed",
    "Added: new-guard",
    "Changed: changed-guard [match, action]",
    "Removed: none",
    "Apply: vibebloat update --apply",
  ].join("\n"));
});

test("release manifests reject local and duplicate guard IDs", () => {
  expect(() => diffCommunityGuards([guard("local", { tier: "local" })], [])).toThrow("not community tier");
  expect(() => diffCommunityGuards([], [guard("same"), guard("same")])).toThrow("duplicate guard id");
});
