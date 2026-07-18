import { existsSync, readFileSync } from "node:fs";
import { withClaudePreToolUseHook } from "./claude";
import { withCodexPreToolUseHook } from "./codex";
import { replaceGuardAtomically } from "../compiler/live-compile";

export interface InstallOptions {
  permitted: boolean;
  claudePath: string;
  codexPath: string;
  command: string;
}

function readJson(path: string): Record<string, unknown> {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function installNativeHooks(options: InstallOptions): void {
  if (!options.permitted) throw new Error("Explicit setup permission is required.");
  const claude = withClaudePreToolUseHook(readJson(options.claudePath), options.command);
  const codex = withCodexPreToolUseHook(readText(options.codexPath), `${options.command} --agent=codex`);
  replaceGuardAtomically(options.claudePath, `${JSON.stringify(claude, null, 2)}\n`);
  replaceGuardAtomically(options.codexPath, codex);
}
