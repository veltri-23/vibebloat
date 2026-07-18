import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { shellShimOwnershipLine } from "../install/shell-shim-ownership";

const CLAUDE_COMMAND = "vibebloat hook";
const CODEX_COMMAND = "vibebloat hook --agent=codex";
const HERMES_MARKER = "# vibebloat-hermes-pre-tool-call";
const GIT_HOOK_START = "# vibebloat:start";
const GIT_HOOK_END = "# vibebloat:end";
const machineData = [
  "guards",
  "proofs",
  "overrides",
  "compile-queue",
  "checkpoints",
  "receipts",
  "audit",
  "cache",
  "failed-ingest",
  "onboarding.json",
  "email.json",
  "compile-budget.json",
  "compile-budget.lock",
  "disabled.json",
] as const;

export interface OpenClawLifecycle {
  isRegistered(pluginId: "vibebloat"): boolean;
  unregister(pluginId: "vibebloat"): void;
  register(pluginId: "vibebloat"): void;
}

export interface UninstallOptions {
  permitted: boolean;
  keepData?: boolean;
  globalHome: string;
  repository?: string;
  claudePath?: string;
  codexPath?: string;
  hermesHome?: string;
  shellShim?: { directory: string; realGitExecutable: string };
  gitHookPaths?: readonly string[];
  openClaw?: OpenClawLifecycle;
  doctor: () => "not-installed" | string;
}

export interface UninstallReport {
  removed: string[];
  absent: string[];
  preserved: string[];
}

interface SharedChange {
  path: string;
  before: string;
  after: string;
  snapshot?: string;
}

interface HermesPlan {
  changes: SharedChange[];
  hookDirectory?: string;
}

interface StagedRemoval {
  original: string;
  staged: string;
}

function failure(why: string): Error {
  return new Error(`WHAT failed: uninstall stopped.\nWHY: ${why}\nFIX: vibebloat doctor`);
}

function requireAbsolute(label: string, path: string): string {
  if (!isAbsolute(path)) throw failure(`${label} path is not absolute.`);
  return resolve(path);
}

function requireOwnedDirectory(label: string, path: string): string {
  const absolute = requireAbsolute(label, path);
  if (absolute === parse(absolute).root) throw failure(`${label} cannot be a filesystem root.`);
  return absolute;
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

export function withoutClaudeHook(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw failure("Claude settings are malformed JSON; zero files changed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw failure("Claude settings must be a JSON object; zero files changed.");
  }
  const settings = parsed as Record<string, unknown>;
  if (settings.hooks === undefined) return source;
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw failure("Claude hooks are malformed; zero files changed.");
  }
  const hooks = settings.hooks as Record<string, unknown>;
  if (hooks.PreToolUse === undefined) return source;
  if (!Array.isArray(hooks.PreToolUse)) throw failure("Claude PreToolUse hooks are malformed; zero files changed.");

  let changed = false;
  const retainedEntries = hooks.PreToolUse.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw failure("Claude PreToolUse hooks are malformed; zero files changed.");
    }
    const record = entry as Record<string, unknown>;
    if (!Array.isArray(record.hooks)) throw failure("Claude PreToolUse commands are malformed; zero files changed.");
    const retainedHooks = record.hooks.filter((hook) => {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
        throw failure("Claude PreToolUse commands are malformed; zero files changed.");
      }
      const command = (hook as Record<string, unknown>).command;
      if (typeof command !== "string") throw failure("Claude PreToolUse commands are malformed; zero files changed.");
      if (command !== CLAUDE_COMMAND) return true;
      changed = true;
      return false;
    });
    return retainedHooks.length ? [{ ...record, hooks: retainedHooks }] : [];
  });
  if (!changed) return source;
  const nextHooks = { ...hooks, PreToolUse: retainedEntries };
  return `${JSON.stringify({ ...settings, hooks: nextHooks }, null, 2)}\n`;
}

function tomlBlocks(source: string): Array<{ start: number; end: number; text: string }> {
  const headers = [...source.matchAll(/^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/gm)].map((match) => ({ name: match[1], index: match.index }));
  return headers.flatMap((header, index) => {
    if (header.name !== "hooks.PreToolUse") return [];
    const next = headers.slice(index + 1).find((candidate) => candidate.name !== "hooks.PreToolUse.hooks");
    const end = next?.index ?? source.length;
    return [{ start: header.index, end, text: source.slice(header.index, end) }];
  });
}

export function withoutCodexHook(source: string): string {
  try {
    Bun.TOML.parse(source);
  } catch {
    throw failure("Codex config is malformed TOML; zero files changed.");
  }
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && !/^(?:\[[^\[\]]+\]|\[\[[^\[\]]+\]\])(?:\s*#.*)?$/.test(trimmed)) {
      throw failure("Codex config has a malformed table header; zero files changed.");
    }
  }
  const encoded = `command = "${CODEX_COMMAND}"`;
  const blocks = tomlBlocks(source);
  const owned = blocks.filter((block) => block.text.split(/\r?\n/).some((line) => line.trim() === encoded));
  if (count(source, CODEX_COMMAND) !== owned.length) {
    throw failure("Codex VibeBloat command is outside an owned PreToolUse block; zero files changed.");
  }
  for (const block of owned) {
    if (!/^\[\[hooks\.PreToolUse\]\]\r?\nmatcher = "Bash\|apply_patch"\r?\n\r?\n\[\[hooks\.PreToolUse\.hooks\]\]\r?\ntype = "command"\r?\ncommand = "vibebloat hook --agent=codex"\r?\n(?:\r?\n)?$/.test(block.text)) {
      throw failure("Codex VibeBloat hook block differs from the installer-owned shape; zero files changed.");
    }
  }
  let next = source;
  for (const block of owned.reverse()) next = `${next.slice(0, block.start)}${next.slice(block.end)}`;
  return next;
}

function decodeYamlSingleQuoted(value: string): string {
  if (!value.startsWith("'") || !value.endsWith("'")) throw failure("Hermes VibeBloat command is malformed; zero files changed.");
  return value.slice(1, -1).replaceAll("''", "'");
}

function withoutHermesBridge(source: string): { source: string; command?: string } {
  const lines = source.split(/(?<=\n)/);
  const markerIndexes = lines.flatMap((line, index) => line.trim() === HERMES_MARKER ? [index] : []);
  if (markerIndexes.length > 1) throw failure("Hermes contains duplicate VibeBloat bridge markers; zero files changed.");
  if (!markerIndexes.length) return { source };
  const index = markerIndexes[0];
  const bridge = lines.slice(index, index + 4);
  if (bridge.length !== 4) throw failure("Hermes VibeBloat bridge is truncated; zero files changed.");
  const indent = bridge[0].match(/^\s*/)?.[0] ?? "";
  const commandMatch = bridge[1].match(new RegExp(`^${indent.replaceAll(" ", "\\s")}- command: (.+?)\\r?\\n?$`));
  if (!commandMatch || !bridge[2].startsWith(`${indent}  matcher:`) || !bridge[3].startsWith(`${indent}  timeout:`)) {
    throw failure("Hermes VibeBloat bridge is malformed; zero files changed.");
  }
  lines.splice(index, 4);
  return { source: lines.join(""), command: decodeYamlSingleQuoted(commandMatch[1]) };
}

function withoutHermesApproval(source: string, command?: string): string {
  if (!source.trim()) return source;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw failure("Hermes shell-hook allowlist is malformed JSON; zero files changed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw failure("Hermes shell-hook allowlist must be an object; zero files changed.");
  }
  const allowlist = parsed as Record<string, unknown>;
  if (!Array.isArray(allowlist.approvals)) throw failure("Hermes shell-hook approvals are malformed; zero files changed.");
  const retained = allowlist.approvals.filter((approval) => {
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) return true;
    const record = approval as Record<string, unknown>;
    return !(command && record.event === "pre_tool_call" && record.command === command);
  });
  if (retained.length === allowlist.approvals.length) return source;
  return `${JSON.stringify({ ...allowlist, approvals: retained }, null, 2)}\n`;
}

function planHermes(home: string): HermesPlan {
  const configPath = join(home, "config.yaml");
  const allowlistPath = join(home, "shell-hooks-allowlist.json");
  const hookDirectory = join(home, "hooks", "vibebloat");
  const config = read(configPath);
  const allowlist = read(allowlistPath);
  const bridge = config === undefined ? { source: "" } : withoutHermesBridge(config);
  const nextAllowlist = allowlist === undefined ? "" : withoutHermesApproval(allowlist, bridge.command);
  if (existsSync(hookDirectory) && !bridge.command && nextAllowlist === allowlist) {
    throw failure("Hermes hook directory has no matching bridge or approval ownership proof; zero files changed.");
  }
  const changes: SharedChange[] = [];
  if (config !== undefined && bridge.source !== config) changes.push({ path: configPath, before: config, after: bridge.source });
  if (allowlist !== undefined && nextAllowlist !== allowlist) changes.push({ path: allowlistPath, before: allowlist, after: nextAllowlist });
  return { changes, hookDirectory: existsSync(hookDirectory) ? hookDirectory : undefined };
}

export function withoutGitHook(source: string): string {
  const starts = count(source, GIT_HOOK_START);
  const ends = count(source, GIT_HOOK_END);
  if (starts !== ends || starts > 1) throw failure("Git hook VibeBloat ownership markers are malformed; zero files changed.");
  if (!starts) return source;
  const start = source.indexOf(GIT_HOOK_START);
  const end = source.indexOf(GIT_HOOK_END, start) + GIT_HOOK_END.length;
  const lineEnd = source.indexOf("\n", end);
  return `${source.slice(0, start)}${source.slice(lineEnd < 0 ? end : lineEnd + 1)}`;
}

function assertOwnedShims(directory: string, realGitExecutable: string): string[] {
  const paths = [join(directory, "git"), join(directory, "git.cmd")];
  const present = paths.filter(existsSync);
  if (present.length === 0) return [];
  if (present.length !== paths.length) throw failure("Git shim installation is partial; zero files changed.");
  const expected = [shellShimOwnershipLine(realGitExecutable), shellShimOwnershipLine(realGitExecutable, true)];
  for (let index = 0; index < paths.length; index += 1) {
    const marker = readFileSync(paths[index], "utf8").split(/\r?\n/)[1];
    if (marker !== expected[index]) throw failure("Git shim ownership marker or real-git target does not match; zero files changed.");
  }
  return paths;
}

function trackedRepositoryPaths(repository: string): string[] {
  const result = Bun.spawnSync({ cmd: ["git", "ls-files", "--", ".vibebloat"], cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw failure("repository tracking status could not be verified; zero files changed.");
  return result.stdout.toString().split(/\r?\n/).filter(Boolean);
}

function snapshot(change: SharedChange): void {
  change.snapshot = join(dirname(change.path), `.${basename(change.path)}.vibebloat-uninstall.${process.pid}.${crypto.randomUUID()}.snapshot`);
  copyFileSync(change.path, change.snapshot);
}

function restore(changes: SharedChange[]): void {
  for (const change of changes) {
    if (change.snapshot && existsSync(change.snapshot)) writeAtomically(change.path, readFileSync(change.snapshot, "utf8"));
  }
}

function cleanSnapshots(changes: SharedChange[]): void {
  for (const change of changes) if (change.snapshot) rmSync(change.snapshot, { force: true });
}

function stageRemoval(path: string): StagedRemoval {
  const staged = join(dirname(path), `.${basename(path)}.vibebloat-uninstall.${process.pid}.${crypto.randomUUID()}.staged`);
  renameSync(path, staged);
  return { original: path, staged };
}

function restoreRemovals(removals: StagedRemoval[]): void {
  for (const removal of [...removals].reverse()) {
    if (existsSync(removal.staged) && !existsSync(removal.original)) renameSync(removal.staged, removal.original);
  }
}

function deleteRemovals(removals: StagedRemoval[]): void {
  for (const removal of removals) rmSync(removal.staged, { recursive: true, force: true });
}

function restoreOpenClaw(lifecycle: OpenClawLifecycle): void {
  if (!lifecycle.isRegistered("vibebloat")) lifecycle.register("vibebloat");
  if (!lifecycle.isRegistered("vibebloat")) throw new Error("OpenClaw registration was not restored.");
}

function executeUninstall(options: UninstallOptions): UninstallReport {
  if (!options.permitted) throw failure("--yes is required before uninstall can change integrations or data.");
  const globalHome = requireOwnedDirectory("global VibeBloat home", options.globalHome);
  const report: UninstallReport = { removed: [], absent: [], preserved: [] };
  const changes: SharedChange[] = [];

  if (options.claudePath) {
    const path = requireAbsolute("Claude settings", options.claudePath);
    const source = read(path);
    if (source === undefined) report.absent.push(path);
    else {
      const after = withoutClaudeHook(source);
      if (after !== source) changes.push({ path, before: source, after });
      else report.absent.push(`${path}:${CLAUDE_COMMAND}`);
    }
  }
  if (options.codexPath) {
    const path = requireAbsolute("Codex config", options.codexPath);
    const source = read(path);
    if (source === undefined) report.absent.push(path);
    else {
      const after = withoutCodexHook(source);
      if (after !== source) changes.push({ path, before: source, after });
      else report.absent.push(`${path}:${CODEX_COMMAND}`);
    }
  }

  let hermes: HermesPlan = { changes: [] };
  if (options.hermesHome) {
    const home = requireOwnedDirectory("Hermes home", options.hermesHome);
    hermes = planHermes(home);
    changes.push(...hermes.changes);
    if (!hermes.changes.length && !hermes.hookDirectory) report.absent.push(`${home}:vibebloat`);
  }

  const hookChanges = (options.gitHookPaths ?? []).map((candidate) => {
    const path = requireAbsolute("Git hook", candidate);
    const source = read(path);
    if (source === undefined) {
      report.absent.push(path);
      return undefined;
    }
    const after = withoutGitHook(source);
    if (after === source) {
      report.absent.push(`${path}:vibebloat`);
      return undefined;
    }
    return { path, before: source, after };
  }).filter((change): change is SharedChange => change !== undefined);
  changes.push(...hookChanges);

  const shimPaths = options.shellShim
    ? assertOwnedShims(requireOwnedDirectory("shell shim directory", options.shellShim.directory), requireAbsolute("real git executable", options.shellShim.realGitExecutable))
    : [];
  const repository = options.repository ? requireAbsolute("repository", options.repository) : undefined;
  const tracked = repository && existsSync(join(repository, ".vibebloat")) ? trackedRepositoryPaths(repository) : [];
  const openClawRegistered = options.openClaw?.isRegistered("vibebloat") ?? false;
  const removals: StagedRemoval[] = [];
  let openClawChanged = false;

  try {
    for (const change of changes) snapshot(change);
    for (const change of changes) {
      writeAtomically(change.path, change.after);
      report.removed.push(change.path);
    }
    if (openClawRegistered) {
      openClawChanged = true;
      options.openClaw?.unregister("vibebloat");
      report.removed.push("openclaw:vibebloat");
    } else if (options.openClaw) report.absent.push("openclaw:vibebloat");
    for (const path of shimPaths) {
      removals.push(stageRemoval(path));
      report.removed.push(path);
    }
    if (hermes.hookDirectory) {
      removals.push(stageRemoval(hermes.hookDirectory));
      report.removed.push(hermes.hookDirectory);
    }
    if (!options.keepData) {
      for (const name of machineData) {
        const path = join(globalHome, name);
        if (!existsSync(path)) continue;
        removals.push(stageRemoval(path));
        report.removed.push(path);
      }
      if (repository) {
        const projectHome = join(repository, ".vibebloat");
        if (existsSync(projectHome) && tracked.length === 0) {
          removals.push(stageRemoval(projectHome));
          report.removed.push(projectHome);
        } else report.preserved.push(...tracked.map((path) => join(repository, path)));
      }
    } else report.preserved.push(globalHome);

    for (const change of changes) {
      const current = readFileSync(change.path, "utf8");
      if (current !== change.after) throw failure("uninstall verification found a changed shared config.");
    }
    if (options.openClaw?.isRegistered("vibebloat")) throw failure("OpenClaw still reports the VibeBloat plugin registered.");
    for (const removal of removals) if (existsSync(removal.original) || !existsSync(removal.staged)) throw failure("an owned artifact was not safely staged for removal.");
    if (options.doctor() !== "not-installed") throw failure("vibebloat doctor did not report not installed.");
  } catch (error) {
    if (openClawChanged) {
      try {
        if (options.openClaw) restoreOpenClaw(options.openClaw);
      } catch {
        restoreRemovals(removals);
        restore(changes);
        throw failure("OpenClaw registration rollback failed; shared files and staged artifacts were restored.");
      }
    }
    restoreRemovals(removals);
    restore(changes);
    throw error instanceof Error && error.message.startsWith("WHAT failed:")
      ? error
      : failure("uninstall mutation or verification failed; shared configs were restored.");
  }

  try {
    deleteRemovals(removals);
    cleanSnapshots(changes);
    if (!options.keepData && existsSync(globalHome) && readdirSync(globalHome).length === 0) rmSync(globalHome, { recursive: true });
    return report;
  } catch {
    throw failure("uninstall committed but cleanup of staged backups failed.");
  }
}

export function uninstallVibeBloat(options: UninstallOptions): UninstallReport {
  try {
    return executeUninstall(options);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("WHAT failed:")) throw error;
    throw failure("uninstall preflight or host lifecycle check failed; zero unverified changes accepted.");
  }
}
