// Shared helper for tests that need `enrichEventWithContext` to observe a
// dirty git working tree. The built-in shell guards are now situational on
// `whenUnstagedChanges: true`; the runtime contract treats a missing runtime
// fact as "unknown" -> no fire, so tests that expect a block must run in (or
// spawn children into) a cwd that `git status --porcelain` reports as
// non-empty. This module owns the temp-repo lifecycle; callers invoke
// `useDirtyGitCwd()` in `beforeAll` and `restoreCwd()` in `afterAll`.
//
// bun runs test files in separate processes, so the chdir is isolated per
// file. Within a file tests run sequentially, so beforeAll/afterAll is
// reliable. For spawned children, pass the returned `cwd` as the spawn's
// `cwd` option along with an absolute path to the script binary.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DirtyGitContext {
  cwd: string;
}

export function createDirtyGitCwd(prefix = "vibebloat-dirty-"): DirtyGitContext {
  const cwd = mkdtempSync(join(tmpdir(), prefix));
  makeDirtyGitRepo(cwd);
  return { cwd };
}

/**
 * Turn an existing directory into a working git repo with one tracked file
 * holding an uncommitted edit. `git status --porcelain` will report a diff,
 * so the situational `whenUnstagedChanges` context fires when the cwd is
 * this directory. Safe to call on a directory that already has content --
 * the initial commit only includes the freshly-created `dirty.txt`.
 */
export function makeDirtyGitRepo(cwd: string): void {
  execSync("git init -q -b main", { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, "dirty.txt"), "baseline\n");
  execSync("git add dirty.txt", { cwd, stdio: "ignore" });
  execSync("git -c user.email=t@t -c user.name=t commit -q -m init", { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, "dirty.txt"), "uncommitted edit\n");
}

export function useDirtyGitCwd(): DirtyGitContext {
  const ctx = createDirtyGitCwd();
  process.chdir(ctx.cwd);
  return ctx;
}

export function restoreCwd(originalCwd: string, ctx: DirtyGitContext): void {
  process.chdir(originalCwd);
  rmSync(ctx.cwd, { recursive: true, force: true });
}
