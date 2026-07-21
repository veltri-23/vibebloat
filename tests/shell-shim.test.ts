import { afterAll, beforeAll, expect, test } from "bun:test";
import { gitStashUntrackedGuard } from "../src/guards";
import { runShellShim } from "../src/hooks/shell-shim";
import { type DirtyGitContext, restoreCwd, useDirtyGitCwd } from "./helpers/dirty-git-cwd";

let dirtyCtx: DirtyGitContext;
let originalCwd: string;
beforeAll(() => {
  originalCwd = process.cwd();
  dirtyCtx = useDirtyGitCwd();
});
afterAll(() => { restoreCwd(originalCwd, dirtyCtx); });

test.each(["bash", "zsh", "fish", "pwsh"])("shell shim blocks Class A command from %s", (shell) => {
  expect(runShellShim([gitStashUntrackedGuard], "git stash -u", shell)).toMatchObject({ exitCode: 2 });
});

test("shell shim allows scoped stash true-negative", () => {
  expect(runShellShim([gitStashUntrackedGuard], "git stash -u -- src/file.ts", "bash")).toEqual({ exitCode: 0 });
});

test.each(["--include-untracked", "-a", "--all"])('shell shim blocks destructive stash variant %s', (flag) => {
  expect(runShellShim([gitStashUntrackedGuard], `git stash ${flag}`, "bash")).toMatchObject({ exitCode: 2 });
});
