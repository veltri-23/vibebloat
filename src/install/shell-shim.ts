import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { applyAtomicFilePlans } from "./atomic-files";
import { ownedShellShimTarget, shellShimOwnershipLine } from "./shell-shim-ownership";

export interface GitShellShimOptions {
  shimDirectory: string;
  runtimePath: string;
  gitExecutable: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function commandQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\"", "\"\"")}"`;
}

function assertOwnedOrAbsent(path: string, windows: boolean): void {
  if (!existsSync(path)) return;
  if (!ownedShellShimTarget(readFileSync(path, "utf8"), windows)) {
    throw new Error(`Refusing to overwrite an unowned or malformed shell shim: ${path}`);
  }
}

export function installGitShellShim(options: GitShellShimOptions): string {
  if (!isAbsolute(options.gitExecutable)) throw new Error("Git shim requires an absolute real git executable path.");
  if (!isAbsolute(options.shimDirectory)) throw new Error("Git shim requires an absolute shim directory.");
  if (!isAbsolute(process.execPath)) throw new Error("Git shim requires an absolute Bun executable path.");
  const shimDirectory = resolve(options.shimDirectory);
  const realGit = resolve(options.gitExecutable);
  const bunExecutable = resolve(process.execPath);
  if ([join(shimDirectory, "git"), join(shimDirectory, "git.cmd")].some((shimPath) => resolve(shimPath) === realGit)) {
    throw new Error("Git shim real executable cannot point at the shim itself.");
  }
  const shimPath = join(shimDirectory, "git");
  const windowsShimPath = join(shimDirectory, "git.cmd");
  assertOwnedOrAbsent(shimPath, false);
  assertOwnedOrAbsent(windowsShimPath, true);
  const sourcePath = options.runtimePath.replaceAll("\\", "/");
  const gitPath = options.gitExecutable.replaceAll("\\", "/");
  const bunPath = bunExecutable.replaceAll("\\", "/");
  applyAtomicFilePlans([
    {
      path: shimPath,
      mode: 0o755,
      content: `#!/bin/sh\n${shellShimOwnershipLine(realGit)}\nexec ${shellQuote(bunPath)} ${shellQuote(sourcePath)} ${shellQuote(gitPath)} "$@"\n`,
    },
    {
      path: windowsShimPath,
      content: `@echo off\r\n${shellShimOwnershipLine(realGit, true)}\r\nsetlocal\r\n${commandQuote(bunPath)} ${commandQuote(sourcePath)} ${commandQuote(gitPath)} %*\r\nexit /b %ERRORLEVEL%\r\n`,
    },
  ]);
  return shimPath;
}
