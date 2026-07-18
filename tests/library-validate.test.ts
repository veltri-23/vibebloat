import { expect, test } from "bun:test";
import { validateCommunityGuard } from "../src/library/validate";

const vector = {
  positive: { chokepoint: "shell" as const, command: "git stash -u" },
  negative: { chokepoint: "shell" as const, command: "git stash -u -- src/file.ts" },
};

function guard(overrides: Record<string, unknown> = {}) {
  return {
    id: "git-stash-untracked", class: "A", provenance: { incident: "lost untracked files", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action: { type: "block", message: "Scope the stash.", override: "vibebloat allow git-stash-untracked --once" },
    confidence: "high", tier: "community", binds: ["claude-code", "codex"], enabled: true, ...overrides,
  };
}

test("community validator requires schema, policy, and proof vectors", () => {
  expect(validateCommunityGuard(guard(), vector).errors).toEqual([]);
});

test("community validator rejects local, low-confidence blocking, and secret-bearing guards", () => {
  expect(validateCommunityGuard(guard({ tier: "local" }), vector).errors).toContain("Community guards must use tier community.");
  expect(validateCommunityGuard(guard({ confidence: "low" }), vector).errors).toContain("Low-confidence community guards must warn.");
  expect(validateCommunityGuard(guard({ provenance: { incident: "token sk_live_secret", date: "2026-07-17", source: "test" } }), vector).errors).toContain("Community guard contains secret, username, or absolute path data.");
});

test("community validator rejects a guard whose true-negative over-blocks", () => {
  const overbroad = guard({ match: { chokepoint: "shell", command: "git stash" } });
  expect(validateCommunityGuard(overbroad, { ...vector, negative: { chokepoint: "shell", command: "git stash" } }).errors).toContain("Negative test vector fires.");
});
