import { expect, test } from "bun:test";
import { compileGuard } from "../src/compiler/codex-fill";

test("compiler fills a validated declarative guard from a typed incident", () => {
  expect(compileGuard({
    incident_id: "git-stash-u",
    class: "A",
    chokepoint: "shell",
    command: "git stash",
    condition: "untracked files present",
    evidence_refs: ["claude-code:one:2:0"],
    severity: 5,
    frequency: 2,
    recency: "2026-07-17",
  }, "high")).toMatchObject({
    id: "git-stash-u",
    action: { type: "block" },
    match: { chokepoint: "shell", command: "git stash" },
  });
});
