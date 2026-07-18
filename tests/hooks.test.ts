import { expect, test } from "bun:test";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";
import { runFileGuard, runPreToolUse } from "../src/hooks";

test("Claude Code Class A hook cell blocks", () => {
  expect(runPreToolUse([gitStashUntrackedGuard], { tool_input: { command: "git stash -u" } })).toMatchObject({ exitCode: 2 });
});

test("Codex Class A hook cell blocks", () => {
  expect(runPreToolUse([gitStashUntrackedGuard], { toolInput: { command: "git stash -u" } })).toMatchObject({ exitCode: 2 });
});

test("Claude Code Class B file cell blocks", () => {
  expect(runFileGuard([mcpConfigWrongFileGuard], { chokepoint: "file", path: ".mcp.json" })).toMatchObject({ exitCode: 2 });
});

test("Codex Class B file cell blocks", () => {
  expect(runPreToolUse([mcpConfigWrongFileGuard], { toolInput: { file_path: ".mcp.json" } })).toMatchObject({ exitCode: 2 });
  expect(runPreToolUse([mcpConfigWrongFileGuard], {
    tool_name: "apply_patch",
    tool_input: { command: "*** Add File: .mcp.json" },
  })).toMatchObject({ exitCode: 2 });
  expect(runFileGuard([mcpConfigWrongFileGuard], { chokepoint: "file", path: ".mcp.json" })).toMatchObject({ exitCode: 2 });
});

test("Codex hook transport emits a deny decision", () => {
  const result = Bun.spawnSync(["bun", "src/cli.ts", "hook", "--agent=codex"], {
    cwd: import.meta.dir + "/..",
    stdin: new Blob([JSON.stringify({ tool_input: { command: "git stash -u" } })]),
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny" },
  });
});

test("unknown hook agent fails closed", () => {
  const result = Bun.spawnSync(["bun", "src/cli.ts", "hook", "--agent=unknown"], {
    cwd: import.meta.dir + "/..",
    stdin: new Blob([JSON.stringify({ tool_input: { command: "git stash -u" } })]),
  });
  expect(result.exitCode).toBe(2);
  expect(new TextDecoder().decode(result.stderr)).toContain("hook agent must be claude-code, codex, or hermes");
});
