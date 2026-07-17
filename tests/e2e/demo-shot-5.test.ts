import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitStashUntrackedGuard } from "../../src/guards";
import { runPreToolUse } from "../../src/hooks";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("Shot 5: blocked stash leaves live untracked files untouched", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shot5-"));
  tempDirectories.push(directory);
  const launcher = join(directory, "launcher.cmd");
  writeFileSync(launcher, "echo safe\n");

  expect(runPreToolUse([gitStashUntrackedGuard], { tool_name: "Bash", tool_input: { command: "git stash -u" } })).toMatchObject({ exitCode: 2 });
  expect(existsSync(launcher)).toBe(true);
});
