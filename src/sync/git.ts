export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitExecutor {
  run(args: readonly string[], cwd: string): GitResult;
}

export const bunGitExecutor: GitExecutor = {
  run(args, cwd) {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  },
};
