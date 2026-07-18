import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface GitShellShimOptions {
  shimDirectory: string;
  runtimePath: string;
  gitExecutable: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function installGitShellShim(options: GitShellShimOptions): string {
  if (!isAbsolute(options.gitExecutable)) throw new Error("Git shim requires an absolute real git executable path.");
  mkdirSync(options.shimDirectory, { recursive: true });
  const shimPath = join(options.shimDirectory, "git");
  const sourcePath = options.runtimePath.replaceAll("\\", "/");
  const gitPath = options.gitExecutable.replaceAll("\\", "/");
  writeFileSync(shimPath, `#!/bin/sh\nexec "\${BUN_EXECUTABLE:-bun}" ${shellQuote(sourcePath)} ${shellQuote(gitPath)} "$@"\n`);
  chmodSync(shimPath, 0o755);
  return shimPath;
}
