import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { applyAtomicFilePlans, type AtomicFilePlan } from "./atomic-files";
import { cliSelfCommand } from "../self-command";

const start = "# vibebloat:start";
const end = "# vibebloat:end";

function quoteArgument(argument: string): string {
  // Git hooks are /bin/sh scripts even on Windows, where a backslash is an
  // escape character. Git accepts forward slashes on every platform.
  const normalized = argument.replaceAll("\\", "/");
  // Single quotes, because inside double quotes sh expands $VAR and backticks:
  // a Windows username containing "$" would otherwise break every commit.
  return /^[A-Za-z0-9_./:-]+$/.test(normalized) ? normalized : `'${normalized.replaceAll("'", `'\\''`)}'`;
}

/**
 * Builds the hook line from the running executable rather than a bare
 * `vibebloat` on PATH. A bare name fails every commit and push in the repo on
 * any machine without a global install, which is a hard break in the user's
 * own work caused by installing us.
 */
export function gitHookCommandLine(hook: GitHookName, selfCommand: readonly string[] = cliSelfCommand()): string {
  return [...selfCommand, "git-hook", hook].map(quoteArgument).join(" ");
}

export type GitHookName = "pre-commit" | "pre-push";

export interface GitHookCommands {
  "pre-commit": string;
  "pre-push": string;
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandRunner = (args: readonly string[], cwd: string) => GitCommandResult;

function defaultGitRunner(args: readonly string[], cwd: string): GitCommandResult {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function assertCommand(command: string): void {
  if (!command.trim() || /[\r\n]/.test(command)) throw new Error("Git hook command must be one non-empty line.");
}

export function gitHookContent(existing: string, command: string): string {
  assertCommand(command);
  const starts = existing.split(start).length - 1;
  const ends = existing.split(end).length - 1;
  if (starts !== ends || starts > 1) throw new Error("VibeBloat Git hook ownership markers are malformed; refusing to overwrite host code.");

  const blockPattern = /^# vibebloat:start\r?\n[^\r\n]+\r?\n# vibebloat:end\r?\n/m;
  const block = `${start}\n${command}\n${end}\n`;
  if (starts === 1) {
    if (!blockPattern.test(existing)) throw new Error("VibeBloat Git hook ownership block is malformed; refusing to overwrite host code.");
    return existing.replace(blockPattern, block);
  }

  const source = existing || "#!/bin/sh\n";
  const shebangEnd = source.startsWith("#!") ? source.indexOf("\n") + 1 : 0;
  const insertion = shebangEnd > 0 ? shebangEnd : 0;
  return `${source.slice(0, insertion)}${block}${source.slice(insertion)}`;
}

export function planGitHook(hookPath: string, command: string): AtomicFilePlan {
  if (!isAbsolute(hookPath)) throw new Error("Git hook path must be absolute.");
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "";
  return { path: hookPath, content: gitHookContent(existing, command), mode: 0o755 };
}

export function installGitHooks(hooks: readonly { path: string; command: string }[]): void {
  const plans = hooks.map((hook) => planGitHook(hook.path, hook.command));
  applyAtomicFilePlans(plans);
}

export function installGitHook(hookPath: string, command: string): void {
  installGitHooks([{ path: hookPath, command }]);
}

export function discoverCurrentRepoGitHookPaths(repository = process.cwd(), runGit: GitCommandRunner = defaultGitRunner): Record<GitHookName, string> {
  const root = resolve(repository);
  const result = runGit(["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "hooks"], root);
  if (result.exitCode !== 0) {
    throw new Error(`Current directory is not an installable Git repository: ${result.stderr.trim() || "git rev-parse failed"}`);
  }
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !isAbsolute(lines[0])) throw new Error("Git returned an invalid hooks directory.");
  const hooksDirectory = resolve(lines[0]);
  return {
    "pre-commit": join(hooksDirectory, "pre-commit"),
    "pre-push": join(hooksDirectory, "pre-push"),
  };
}

export function installCurrentRepoGitHooks(
  repository: string,
  commands: GitHookCommands,
  runGit: GitCommandRunner = defaultGitRunner,
): Record<GitHookName, string> {
  const paths = discoverCurrentRepoGitHookPaths(repository, runGit);
  installGitHooks([
    { path: paths["pre-commit"], command: commands["pre-commit"] },
    { path: paths["pre-push"], command: commands["pre-push"] },
  ]);
  return paths;
}
