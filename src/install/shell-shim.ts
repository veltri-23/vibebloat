import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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

export function installGitShellShim(options: GitShellShimOptions): string {
  if (!isAbsolute(options.gitExecutable)) throw new Error("Git shim requires an absolute real git executable path.");
  if (!isAbsolute(options.shimDirectory)) throw new Error("Git shim requires an absolute shim directory.");
  const shimDirectory = resolve(options.shimDirectory);
  const realGit = resolve(options.gitExecutable);
  if ([join(shimDirectory, "git"), join(shimDirectory, "git.cmd")].some((shimPath) => resolve(shimPath) === realGit)) {
    throw new Error("Git shim real executable cannot point at the shim itself.");
  }
  mkdirSync(shimDirectory, { recursive: true });
  const shimPath = join(shimDirectory, "git");
  const windowsShimPath = join(shimDirectory, "git.cmd");
  const sourcePath = options.runtimePath.replaceAll("\\", "/");
  const gitPath = options.gitExecutable.replaceAll("\\", "/");
  writeFileSync(shimPath, `#!/bin/sh\nexec "\${BUN_EXECUTABLE:-bun}" ${shellQuote(sourcePath)} ${shellQuote(gitPath)} "$@"\n`);
  chmodSync(shimPath, 0o755);
  writeFileSync(windowsShimPath, `@echo off\r\nsetlocal\r\nif defined BUN_EXECUTABLE (\r\n  "%BUN_EXECUTABLE%" ${commandQuote(sourcePath)} ${commandQuote(gitPath)} %*\r\n) else (\r\n  bun ${commandQuote(sourcePath)} ${commandQuote(gitPath)} %*\r\n)\r\nexit /b %ERRORLEVEL%\r\n`);
  return shimPath;
}
