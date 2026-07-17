import { expect, test } from "bun:test";
import { gitStashUntrackedGuard } from "../src/guards";
import { runShellShim } from "../src/hooks/shell-shim";

test.each(["bash", "zsh", "fish", "pwsh"])("shell shim blocks Class A command from %s", (shell) => {
  expect(runShellShim([gitStashUntrackedGuard], "git stash -u", shell)).toMatchObject({ exitCode: 2 });
});

test("shell shim allows scoped stash true-negative", () => {
  expect(runShellShim([gitStashUntrackedGuard], "git stash -u -- src/file.ts", "bash")).toEqual({ exitCode: 0 });
});
