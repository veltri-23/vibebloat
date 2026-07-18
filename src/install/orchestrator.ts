import { existsSync, readFileSync, type FSWatcher } from "node:fs";
import { withClaudePreToolUseHook } from "./claude";
import { withCodexPreToolUseHook } from "./codex";
import { replaceGuardAtomically } from "../compiler/live-compile";
import { watchGuardedWrites } from "./fs-guard";
import { installGitHook } from "./git-hooks";
import { verifyShellPaths, type Shell } from "./shim";
import type { HookResponse } from "../hooks";
import type { Guard } from "../types";

export interface FallbackInstallOptions {
  shimDirectory: string;
  readPath: (shell: Shell, probe: string) => string;
  gitHookPaths: readonly string[];
  fsWatchDirectory: string;
  guards: Guard[];
  onFsBlocked: (path: string, response: HookResponse) => void;
}

export interface InstallOptions {
  permitted: boolean;
  claudePath: string;
  codexPath: string;
  command: string;
  fallback?: FallbackInstallOptions;
}

function readJson(path: string): Record<string, unknown> {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function installNativeHooks(options: InstallOptions): FSWatcher | undefined {
  if (!options.permitted) throw new Error("Explicit setup permission is required.");
  const fallback = options.fallback;
  if (fallback) verifyShellPaths(fallback.shimDirectory, fallback.readPath);
  const claude = withClaudePreToolUseHook(readJson(options.claudePath), options.command);
  const codex = withCodexPreToolUseHook(readText(options.codexPath), `${options.command} --agent=codex`);
  replaceGuardAtomically(options.claudePath, `${JSON.stringify(claude, null, 2)}\n`);
  replaceGuardAtomically(options.codexPath, codex);
  if (!fallback) return undefined;
  for (const hookPath of fallback.gitHookPaths) installGitHook(hookPath, options.command);
  return watchGuardedWrites(fallback.fsWatchDirectory, fallback.guards, fallback.onFsBlocked);
}
