import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Event } from "../types";

const maxConfigBytes = 256 * 1024;
const maxShellCommandBytes = 64 * 1024;

export interface GitAliasOptions {
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
}

interface ConfigText {
  text?: string;
  failed: boolean;
}

export interface GitAliasResolution {
  aliases: Record<string, string>;
  failed: boolean;
}

function configText(path: string): ConfigText {
  try {
    const file = lstatSync(path);
    if (!file.isFile()) return { failed: false };
    if (file.size > maxConfigBytes) return { failed: true };
    return { text: readFileSync(path, "utf8"), failed: false };
  } catch (error) {
    return { failed: (error as NodeJS.ErrnoException).code !== "ENOENT" };
  }
}

function gitDirectoryConfig(cwd: string): string | undefined {
  for (let directory = resolve(cwd); ; directory = dirname(directory)) {
    const dotGit = join(directory, ".git");
    try {
      if (lstatSync(dotGit).isDirectory()) return join(dotGit, "config");
      const pointer = configText(dotGit).text?.match(/^gitdir:\s*(.+)\s*$/im)?.[1];
      if (pointer) return join(isAbsolute(pointer) ? pointer : resolve(dirname(dotGit), pointer), "config");
    } catch {}
    const parent = dirname(directory);
    if (parent === directory) return undefined;
  }
}

function aliasConfigPaths(options: Required<GitAliasOptions>): string[] {
  const home = options.environment.HOME ?? options.environment.USERPROFILE;
  const paths = [
    home && join(home, ".gitconfig"),
    options.environment.XDG_CONFIG_HOME && join(options.environment.XDG_CONFIG_HOME, "git", "config"),
    gitDirectoryConfig(options.cwd),
  ].filter((path): path is string => Boolean(path));
  return [...new Set(paths)];
}

function configAliases(text: string): Record<string, string> {
  const aliases: Record<string, string> = {};
  let inAliasSection = false;
  for (const sourceLine of text.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[([^\]]+)\]$/.exec(line)?.[1]?.trim().toLowerCase();
    if (section !== undefined) {
      inAliasSection = section === "alias";
      continue;
    }
    const entry = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!entry) continue;
    const key = entry[1].trim();
    const alias = inAliasSection ? key : /^alias\.(.+)$/i.exec(key)?.[1];
    if (!alias || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(alias)) continue;
    aliases[alias] = entry[2].trim();
  }
  return aliases;
}

export function readGitAliases(options: GitAliasOptions = {}): Record<string, string> {
  return resolveGitAliases(options).aliases;
}

export function resolveGitAliases(options: GitAliasOptions = {}): GitAliasResolution {
  const resolved: Required<GitAliasOptions> = {
    cwd: options.cwd ?? process.cwd(),
    environment: options.environment ?? process.env,
  };
  const aliases: Record<string, string> = {};
  let failed = false;
  for (const path of aliasConfigPaths(resolved)) {
    const config = configText(path);
    failed ||= config.failed;
    Object.assign(aliases, configAliases(config.text ?? ""));
  }
  return { aliases, failed };
}

function mayUseGitAlias(command: string): boolean {
  if (Buffer.byteLength(command, "utf8") > maxShellCommandBytes) return false;
  return /(?:^|[;&|\s])(?:[A-Za-z]:[\\/][^\s]+[\\/]|\/[^\s]+\/)?git(?:\.exe)?(?=\s|$)/i.test(command) || command.includes("$");
}

export function withGitAliases(event: Event, options: GitAliasOptions = {}): Event {
  if (event.chokepoint !== "shell" || !event.command || event.aliases || !mayUseGitAlias(event.command)) return event;
  const resolution = resolveGitAliases(options);
  return { ...event, aliases: resolution.aliases, aliasResolutionFailed: resolution.failed };
}
