import { expect, test } from "bun:test";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";
import { runFileGuard, runPreToolUse } from "../src/hooks";

test("Claude Code Class A hook cell blocks", () => {
  expect(runPreToolUse([gitStashUntrackedGuard], { tool_input: { command: "git stash -u" } })).toMatchObject({ exitCode: 2 });
});

test("Codex Class A hook cell blocks", () => {
  expect(runPreToolUse([gitStashUntrackedGuard], { tool_input: { command: "git stash -u" } })).toMatchObject({ exitCode: 2 });
});

test("Claude Code Class B file cell blocks", () => {
  expect(runFileGuard([mcpConfigWrongFileGuard], { chokepoint: "file", path: ".mcp.json" })).toMatchObject({ exitCode: 2 });
});

test("Codex Class B file cell blocks", () => {
  expect(runFileGuard([mcpConfigWrongFileGuard], { chokepoint: "file", path: ".mcp.json" })).toMatchObject({ exitCode: 2 });
});
