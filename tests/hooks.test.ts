import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";
import { runFileGuard, runPreToolUse } from "../src/hooks";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function hookEnvironment(): NodeJS.ProcessEnv {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hook-"));
  temporaryDirectories.push(home);
  return { ...process.env, USERPROFILE: home, HOME: home };
}

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
    env: hookEnvironment(),
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
    env: hookEnvironment(),
    stdin: new Blob([JSON.stringify({ tool_input: { command: "git stash -u" } })]),
  });
  expect(result.exitCode).toBe(2);
  expect(new TextDecoder().decode(result.stderr)).toBe("WHAT failed: guard hook evaluation stopped.\nWHY: guard runtime could not load or evaluate installed guards.\nFIX: vibebloat doctor\n");
});
