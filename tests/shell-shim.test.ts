import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("shell shim situational context uses recorded real Git instead of PATH shim", () => {
  const realGit = Bun.which("git");
  expect(realGit).toBeTruthy();
  const fakeDirectory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shell-shim-path-"));
  const marker = join(fakeDirectory, "path-shim-ran");
  const fakeGit = join(fakeDirectory, process.platform === "win32" ? "git.cmd" : "git");
  writeFileSync(fakeGit, process.platform === "win32"
    ? `@echo touched>"${marker}"\r\n@exit /b 0\r\n`
    : `#!/bin/sh\nprintf touched > "${marker}"\n`, { mode: 0o755 });
  try {
    const handlerUrl = pathToFileURL(join(originalCwd, "src", "hooks", "shell-shim-handler.ts")).href;
    const script = `
      import { runShellShimCommand } from ${JSON.stringify(handlerUrl)};
      process.exit(runShellShimCommand(${JSON.stringify(realGit)}, ["status", "--porcelain"], { cliCommand: [process.execPath] }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${fakeDirectory}${delimiter}${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(marker)).toBeFalse();
  } finally {
    rmSync(fakeDirectory, { recursive: true, force: true });
  }
});
