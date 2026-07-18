import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withClaudePreToolUseHook, type ClaudeSettings } from "./claude";
import { withCodexPreToolUseHook } from "./codex";
import {
  inspectPersistentFsGuard,
  launchPersistentFsGuard,
  type DetachedFsGuardProcess,
  type ProcessIdentityState,
} from "./fs-guard";
import { discoverCurrentRepoGitHookPaths, planGitHook, type GitHookCommands } from "./git-hooks";
import { installHermesHook, preflightHermesHook, type HermesHookInstallOptions } from "./hermes";
import { ownedShellShimTarget } from "./shell-shim-ownership";
import { installGitShellShim } from "./shell-shim";
import { verifyShellPaths, type Shell } from "./shim";
import { applyAtomicFilePlans, type AtomicFilePlan } from "./atomic-files";

const nativeEnvironments = new Set(["claude-code", "codex", "hermes", "openclaw"]);
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface FallbackBindingOptions {
  shimDirectory: string;
  gitExecutable: string;
  readPath(shell: Shell, probe: string): string;
  selfCommand?: readonly string[];
  runtimePath?: string;
  fsGuardCommand: readonly string[];
  spawnFsGuard?: (command: readonly string[], cwd: string) => DetachedFsGuardProcess;
  probeFsGuard?: (pid: number, instanceId: string) => ProcessIdentityState;
  sleep?: (milliseconds: number) => void;
  instanceId?: string;
  now?: Date;
}

export interface OnboardingBindingInstallOptions {
  permitted: boolean;
  environmentIds: readonly string[];
  repository: string;
  command: string;
  gitCommands: GitHookCommands;
  claudePath?: string;
  codexPath?: string;
  hermes?: Omit<HermesHookInstallOptions, "permitted">;
  verifyOpenClawRegistration?: (pluginId: "vibebloat") => boolean;
  fallback?: FallbackBindingOptions;
  now?: Date;
}

export type BindingMechanism =
  | "claude-pre-tool-use"
  | "codex-pre-tool-use"
  | "hermes-digest-bound-hook"
  | "openclaw-host-registration"
  | "shell-git-fs-fallback";

export interface OnboardingBindingReceipt {
  schemaVersion: 1;
  owner: "vibebloat";
  kind: "onboarding-bindings";
  environments: Array<{ id: string; mechanism: BindingMechanism }>;
  gitBaseline: "verified";
  verifiedAt: string;
}

const mechanismForEnvironment = (id: string): BindingMechanism => id === "claude-code" ? "claude-pre-tool-use"
  : id === "codex" ? "codex-pre-tool-use"
    : id === "hermes" ? "hermes-digest-bound-hook"
      : id === "openclaw" ? "openclaw-host-registration"
        : "shell-git-fs-fallback";

interface NativePlans {
  plans: AtomicFilePlan[];
  claude?: { path: string; content: string };
  codex?: { path: string; content: string };
}

function readClaude(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Claude settings must be a JSON object.");
  return parsed as ClaudeSettings;
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function requiredAbsolutePath(path: string | undefined, label: string): string {
  if (!path || !isAbsolute(path)) throw new Error(`${label} must be an explicit absolute path.`);
  return resolve(path);
}

function requiredAbsoluteFile(path: string | undefined, label: string): string {
  const resolved = requiredAbsolutePath(path, label);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`${label} must be an existing regular file.`);
  }
  return resolved;
}

function selectedEnvironmentIds(environmentIds: readonly string[]): string[] {
  if (new Set(environmentIds).size !== environmentIds.length) throw new Error("Binding selection contains duplicate environment identifiers.");
  if (environmentIds.some((id) => id.length > 80 || !identifier.test(id))) throw new Error("Binding selection contains an unsafe environment identifier.");
  return [...environmentIds].sort();
}

function assertSafeReceiptParent(repository: string): void {
  for (const path of [join(repository, ".vibebloat"), join(repository, ".vibebloat", "receipts")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Binding receipt parent cannot be a symbolic link.");
  }
}

function nativePlans(options: OnboardingBindingInstallOptions, selected: ReadonlySet<string>): NativePlans {
  const result: NativePlans = { plans: [] };
  if (selected.has("claude-code")) {
    const path = requiredAbsolutePath(options.claudePath, "Claude settings path");
    const content = `${JSON.stringify(withClaudePreToolUseHook(readClaude(path), options.command), null, 2)}\n`;
    result.claude = { path, content };
    result.plans.push({ path, content });
  }
  if (selected.has("codex")) {
    const path = requiredAbsolutePath(options.codexPath, "Codex config path");
    const content = withCodexPreToolUseHook(readText(path), `${options.command} --agent=codex`);
    result.codex = { path, content };
    result.plans.push({ path, content });
  }
  return result;
}

function assertVerifiedGitHook(path: string, command: string): void {
  const source = readFileSync(path, "utf8");
  const expected = `# vibebloat:start\n${command}\n# vibebloat:end\n`;
  if (!source.includes(expected)
    || source.split("# vibebloat:start").length !== 2
    || source.split("# vibebloat:end").length !== 2) {
    throw new Error("Git baseline hook verification failed.");
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) throw new Error(`${label} verification failed.`);
}

function assertVerifiedHermes(options: Omit<HermesHookInstallOptions, "permitted">): void {
  const sourceDirectory = options.sourceDirectory ?? join(import.meta.dir, "../../hermes");
  const sourceHandler = join(sourceDirectory, "handler.py");
  const sourceManifest = join(sourceDirectory, "HOOK.yaml");
  const installedDirectory = join(options.hermesHome, "hooks", "vibebloat");
  const handler = join(installedDirectory, "handler.py");
  const manifest = join(installedDirectory, "HOOK.yaml");
  assertRegularFile(handler, "Hermes handler");
  assertRegularFile(manifest, "Hermes hook manifest");
  const digest = sha256(sourceHandler);
  if (sha256(handler) !== digest || readFileSync(manifest, "utf8") !== readFileSync(sourceManifest, "utf8")) {
    throw new Error("Hermes installed hook integrity verification failed.");
  }
  const command = `"${options.pythonExecutable}" "${handler}" --vibebloat-handler-sha=${digest}`;
  const config = readFileSync(join(options.hermesHome, "config.yaml"), "utf8");
  if (!config.includes("# vibebloat-hermes-pre-tool-call") || !config.includes(command)) {
    throw new Error("Hermes digest-bound config verification failed.");
  }
  const allowlist: unknown = JSON.parse(readFileSync(join(options.hermesHome, "shell-hooks-allowlist.json"), "utf8"));
  const approvals = allowlist && typeof allowlist === "object" && !Array.isArray(allowlist)
    ? (allowlist as { approvals?: unknown }).approvals
    : undefined;
  if (!Array.isArray(approvals) || !approvals.some((approval) => {
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
    const entry = approval as Record<string, unknown>;
    return entry.event === "pre_tool_call"
      && entry.command === command
      && typeof entry.approved_at === "string"
      && typeof entry.script_mtime_at_approval === "string";
  })) throw new Error("Hermes digest-bound allowlist verification failed.");
}

function assertOpenClawRegistered(verifier: OnboardingBindingInstallOptions["verifyOpenClawRegistration"]): void {
  if (!verifier || verifier("vibebloat") !== true) throw new Error("OpenClaw host did not verify VibeBloat plugin registration.");
}

function assertFallbackPreflight(repository: string, fallback: FallbackBindingOptions | undefined): asserts fallback is FallbackBindingOptions {
  if (!fallback) throw new Error("Selected non-native environments require verified shell and filesystem fallback bindings.");
  requiredAbsolutePath(fallback.shimDirectory, "Fallback shim directory");
  requiredAbsoluteFile(fallback.gitExecutable, "Fallback Git executable");
  if (Boolean(fallback.selfCommand) === Boolean(fallback.runtimePath)) throw new Error("Fallback binding requires exactly one explicit runtime command.");
  if (fallback.selfCommand) requiredAbsoluteFile(fallback.selfCommand[0], "Fallback runtime executable");
  else requiredAbsoluteFile(fallback.runtimePath, "Fallback runtime path");
  const fsCommand = [...fallback.fsGuardCommand];
  const watchIndex = fsCommand.indexOf("watch");
  requiredAbsoluteFile(fsCommand[0], "Filesystem guard executable");
  if (fsCommand.length < 3 || watchIndex < 1 || resolve(fsCommand[watchIndex + 1] ?? "") !== repository) {
    throw new Error("Filesystem guard command must watch the explicit repository path.");
  }
  verifyShellPaths(fallback.shimDirectory, fallback.readPath);
}

function installAndVerifyFallback(repository: string, fallback: FallbackBindingOptions): void {
  installGitShellShim({
    shimDirectory: fallback.shimDirectory,
    gitExecutable: fallback.gitExecutable,
    ...(fallback.selfCommand ? { selfCommand: fallback.selfCommand } : { runtimePath: fallback.runtimePath! }),
  });
  launchPersistentFsGuard({
    directory: repository,
    command: fallback.fsGuardCommand,
    ...(fallback.spawnFsGuard ? { spawn: fallback.spawnFsGuard } : {}),
    ...(fallback.probeFsGuard ? { probeProcess: fallback.probeFsGuard } : {}),
    ...(fallback.sleep ? { sleep: fallback.sleep } : {}),
    ...(fallback.instanceId ? { instanceId: fallback.instanceId } : {}),
    ...(fallback.now ? { now: fallback.now } : {}),
  });
  verifyShellPaths(fallback.shimDirectory, fallback.readPath);
  const expectedGit = resolve(fallback.gitExecutable);
  const posixTarget = ownedShellShimTarget(readFileSync(join(fallback.shimDirectory, "git"), "utf8"));
  const windowsTarget = ownedShellShimTarget(readFileSync(join(fallback.shimDirectory, "git.cmd"), "utf8"), true);
  if (posixTarget !== expectedGit || windowsTarget !== expectedGit) throw new Error("Fallback shell shim ownership verification failed.");
  if (inspectPersistentFsGuard({ directory: repository, ...(fallback.probeFsGuard ? { probeProcess: fallback.probeFsGuard } : {}) }) !== "healthy") {
    throw new Error("Fallback filesystem guard verification failed.");
  }
}

function receiptFor(selected: readonly string[], verifiedAt: Date): OnboardingBindingReceipt {
  const environments = selected.map((id): OnboardingBindingReceipt["environments"][number] => ({
    id,
    mechanism: mechanismForEnvironment(id),
  }));
  return {
    schemaVersion: 1,
    owner: "vibebloat",
    kind: "onboarding-bindings",
    environments,
    gitBaseline: "verified",
    verifiedAt: verifiedAt.toISOString(),
  };
}

export function readOnboardingBindingReceipt(repository: string): OnboardingBindingReceipt | undefined {
  if (!isAbsolute(repository)) return undefined;
  const path = join(resolve(repository), ".vibebloat", "receipts", "onboarding-bindings.json");
  try {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const receipt = value as Record<string, unknown>;
    if (receipt.schemaVersion !== 1 || receipt.owner !== "vibebloat" || receipt.kind !== "onboarding-bindings" || receipt.gitBaseline !== "verified") return undefined;
    if (typeof receipt.verifiedAt !== "string" || !Number.isFinite(Date.parse(receipt.verifiedAt)) || !Array.isArray(receipt.environments)) return undefined;
    const ids: string[] = [];
    for (const entry of receipt.environments) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || !identifier.test(item.id) || item.mechanism !== mechanismForEnvironment(item.id)) return undefined;
      ids.push(item.id);
    }
    if (new Set(ids).size !== ids.length) return undefined;
    return value as OnboardingBindingReceipt;
  } catch {
    return undefined;
  }
}

export function installOnboardingBindings(options: OnboardingBindingInstallOptions): OnboardingBindingReceipt {
  if (!options.permitted) throw new Error("Explicit setup permission is required.");
  if (!options.command.trim() || /[\r\n]/.test(options.command)) throw new Error("Native hook command must be one non-empty line.");
  const selected = selectedEnvironmentIds(options.environmentIds);
  const selectedSet = new Set(selected);
  const repositoryPath = requiredAbsolutePath(options.repository, "Repository");
  if (!existsSync(repositoryPath) || !statSync(repositoryPath).isDirectory()) throw new Error("Repository must be an existing absolute directory.");
  const repository = realpathSync(repositoryPath);
  assertSafeReceiptParent(repository);
  const verifiedAt = options.now ?? new Date();
  if (!Number.isFinite(verifiedAt.getTime())) throw new Error("Binding receipt clock is invalid.");

  const plans = nativePlans(options, selectedSet);
  const gitPaths = discoverCurrentRepoGitHookPaths(repository);
  const gitPlans = [
    planGitHook(gitPaths["pre-commit"], options.gitCommands["pre-commit"]),
    planGitHook(gitPaths["pre-push"], options.gitCommands["pre-push"]),
  ];
  if (selectedSet.has("hermes")) {
    if (!options.hermes) throw new Error("Selected Hermes environment requires explicit home and Python paths.");
    preflightHermesHook({ ...options.hermes, permitted: true });
  }
  if (selectedSet.has("openclaw")) assertOpenClawRegistered(options.verifyOpenClawRegistration);
  const needsFallback = selected.some((id) => !nativeEnvironments.has(id));
  if (needsFallback) assertFallbackPreflight(repository, options.fallback);

  applyAtomicFilePlans([...plans.plans, ...gitPlans]);
  if (options.hermes && selectedSet.has("hermes")) installHermesHook({ ...options.hermes, permitted: true });
  if (needsFallback) installAndVerifyFallback(repository, options.fallback!);

  if (plans.claude && readFileSync(plans.claude.path, "utf8") !== plans.claude.content) throw new Error("Claude native hook verification failed.");
  if (plans.codex && readFileSync(plans.codex.path, "utf8") !== plans.codex.content) throw new Error("Codex native hook verification failed.");
  assertVerifiedGitHook(gitPaths["pre-commit"], options.gitCommands["pre-commit"]);
  assertVerifiedGitHook(gitPaths["pre-push"], options.gitCommands["pre-push"]);
  if (options.hermes && selectedSet.has("hermes")) assertVerifiedHermes(options.hermes);
  if (selectedSet.has("openclaw")) assertOpenClawRegistered(options.verifyOpenClawRegistration);

  const receipt = receiptFor(selected, verifiedAt);
  const receiptPath = join(repository, ".vibebloat", "receipts", "onboarding-bindings.json");
  applyAtomicFilePlans([{ path: receiptPath, content: `${JSON.stringify(receipt, null, 2)}\n`, mode: 0o600 }]);
  return receipt;
}
