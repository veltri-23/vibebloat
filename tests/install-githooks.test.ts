import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverCurrentRepoGitHookPaths, installCurrentRepoGitHooks, installGitHook, installGitHooks } from "../src/install/git-hooks";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("git hook install runs first after the shebang without replacing an existing hook", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-git-"));
  tempDirectories.push(directory);
  const hookPath = join(directory, "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\necho existing\n");

  installGitHook(hookPath, "bun vibebloat hook");
  installGitHook(hookPath, "bun vibebloat hook");

  expect(readFileSync(hookPath, "utf8")).toBe("#!/bin/sh\n# vibebloat:start\nbun vibebloat hook\n# vibebloat:end\necho existing\n");
});

test("git hook install updates only its owned command block", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-git-"));
  tempDirectories.push(directory);
  const hookPath = join(directory, "pre-push");
  writeFileSync(hookPath, "#!/bin/sh\n# vibebloat:start\nold command\n# vibebloat:end\necho existing\n");

  installGitHook(hookPath, "new command");

  expect(readFileSync(hookPath, "utf8")).toBe("#!/bin/sh\n# vibebloat:start\nnew command\n# vibebloat:end\necho existing\n");
});

test("all Git hooks preflight before any host file changes", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-git-"));
  tempDirectories.push(directory);
  const first = join(directory, "pre-commit");
  const second = join(directory, "pre-push");
  writeFileSync(first, "#!/bin/sh\necho keep first\n");
  writeFileSync(second, "#!/bin/sh\n# vibebloat:start\necho malformed\n");

  expect(() => installGitHooks([
    { path: first, command: "vibebloat git-hook pre-commit" },
    { path: second, command: "vibebloat git-hook pre-push" },
  ])).toThrow("malformed");
  expect(readFileSync(first, "utf8")).toBe("#!/bin/sh\necho keep first\n");
});

test("current repository discovery respects Git's configured hooks path and installs both hooks", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-git-"));
  tempDirectories.push(directory);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: directory }).exitCode).toBe(0);
  expect(Bun.spawnSync(["git", "config", "core.hooksPath", ".owned-hooks"], { cwd: directory }).exitCode).toBe(0);

  const discovered = discoverCurrentRepoGitHookPaths(directory);
  expect(discovered["pre-commit"]).toBe(join(directory, ".owned-hooks", "pre-commit"));
  expect(discovered["pre-push"]).toBe(join(directory, ".owned-hooks", "pre-push"));

  const installed = installCurrentRepoGitHooks(directory, {
    "pre-commit": "vibebloat git-hook pre-commit",
    "pre-push": "vibebloat git-hook pre-push",
  });
  expect(installed).toEqual(discovered);
  expect(existsSync(discovered["pre-commit"])).toBeTrue();
  expect(readFileSync(discovered["pre-push"], "utf8")).toContain("vibebloat git-hook pre-push");
});
