import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import packageMetadata from "../package.json";
import { createFiringRecorder, readAndPruneFirings, readLastFiredSummaries } from "./audit/firings";
import { disableGuard, disabledGuardIds } from "./cli/disable";
import { formatDailyStrengtheningFailure, runDailyStrengtheningCommand } from "./cli/daily";
import { summarizeRules } from "./cli/rules";
import { installationState, readInstalledAtByGuard, runDoctor } from "./doctor/checks";
import { globalGuardHome, guardDirectories, guardHomeForScope, guardHomes, onboardingHome } from "./guard-home";
import { loadGuards } from "./guard-loader";
import { forgetEmail } from "./growth/email-capture";
import { canonicalGuardId, gitCheckoutDiscardGuard, gitCleanForceGuard, gitResetHardGuard, gitStashUntrackedGuard, mcpConfigWrongFileGuard, npxMcpHangGuard } from "./guards";
import { formatGuardRuntimeFailure, hookResponseForVerdict, runPreToolUse } from "./hooks";
import { match } from "./match";
import { closeWatcherOnSignals, fsGuardReceiptPath, hasUnenforceableFileGuard, inspectPersistentFsGuard, launchPersistentFsGuard, stopPersistentFsGuard, waitForFsGuardLaunchReceipt, watchFsGuardStopRequests, watchGuardedWrites } from "./install/fs-guard";
import { discoverCurrentRepoGitHookPaths, gitHookCommandLine, installCurrentRepoGitHooks, planGitHook, type GitHookName } from "./install/git-hooks";
import { installNativeHooks } from "./install/orchestrator";
import { installHermesHook, preflightHermesHook } from "./install/hermes";
import { installOnboardingBindings, readOnboardingBindingReceipt } from "./install/onboarding-bindings";
import { DailySchedulerTargetUnavailableError, installVerifiedStandaloneDailyScheduler } from "./install/daily-scheduler";
import { installStarterGuardPack } from "./install/starter-pack";
import { claimStarPack, type StarPackClaimReport } from "./growth/star-pack";
import { verifyShellPaths, type Shell } from "./install/shim";
import { compileGuard } from "./compiler/codex-fill";
import { syntheticEvent } from "./compiler/synthetic-event";
import { compileLiveForScope, drainQueuedLiveCompilesForScope } from "./compiler/live-compile";
import { approveLiveCompileProposal, authorizeHumanLiveCompileApproval, drainQueuedLiveProposalsForScope, processQueuedLiveProposal, reviewLiveCompileProposal } from "./compiler/live-incident";
import { runShellShimCommand } from "./hooks/shell-shim-handler";
import { cliSelfCommand } from "./self-command";
import { createCodebaseMemorySemanticAdapter } from "./ingest/codebase-memory-semantic";
import { discoverLocalHistory, type LocalHistoryCatalog } from "./ingest/discovery";
import { scanIncrementalHistory } from "./ingest/incremental-cursor";
import { createLocalSemanticAdapter, localSemanticIndexPath } from "./ingest/local-semantic";
import { scanHistory } from "./ingest/scan";
import type { UntrustedSemanticContext } from "./ingest/semantic-context";
import { rankIncidents, type IncidentManifest } from "./ingest/rank";
import { onboardingGateValues } from "./onboarding/gate-measurements";
import type { HistoryChunk } from "./ingest/types";
import { buildChatCompletionsBody, parseModelIncidentOutput, serializeModelCommandInput, usesChatCompletionsWire } from "./mine/model-command-input";
import { detectRunnerDetails, parentProcessCommand, parseRunnerOverride, type RunnerDetectionSource } from "./onboarding/detect-runner";
import { answerAssist } from "./onboarding/assist";
import { validateOnboardingEffectRequirements, type EffectGateId, type OnboardingEffectEvidence } from "./onboarding/effect-requirements";
import { canonicalGateChoice, gateValues, isGateChoice, type OnboardingContext } from "./onboarding/gates";
import { assertSafeIncident, OnboardingCoordinator, reviewDecisionForChoice, type GuardReviewDecision, type OnboardingCheckpoint } from "./onboarding/coordinator";
import { lookupMarkdownAnswer } from "./onboarding/markdown-help";
import { readCustomAgentHomes, revokeCustomAgentHomes, saveCustomAgentHome, type CustomAgentHomes } from "./onboarding/custom-agent-homes";
import { applyOnboardingPreference, modelCommandEnvironmentName, type ModelRoute } from "./onboarding/preferences";
import { getReturningGate, recordReturningConversation, returningRoute, type ReturningChoice } from "./onboarding/returning";
import { runReturningService } from "./onboarding/returning-service";
import { OnboardingRunner, type RunnerState } from "./onboarding/runner";
import { loadOnboardingState, saveOnboardingState, type OnboardingState } from "./onboarding/state";
import { Runtime } from "./runtime";
import { allowOnce, consumeAllowedOnce } from "./runtime/override";
import { parseGuard } from "./schema";
import { executeCommand } from "./scrub/command";
import { ControlledScrubbersUnavailableError, resolveControlledScrubberCommands } from "./scrub/controlled-release";
import { resolveScrubbers } from "./scrub/resolve";
import { createLocalOnlySink } from "./scrub/local-sink";
import { readLocalStats } from "./stats/local";
import { applyPull, fetchAndPlanPull, GuardSyncError, type GuardSyncDiff } from "./sync";
import type { Event, Guard, GuardAgent } from "./types";
import { uninstallVibeBloat } from "./uninstall";
import { formatUpdateCommandFailure, formatUpdateCommandResult, parseUpdateArguments, runControlledUpdateCommand } from "./updater/command";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard, gitResetHardGuard, gitCheckoutDiscardGuard, gitCleanForceGuard, npxMcpHangGuard];
const gitHookCommands = {
  "pre-commit": gitHookCommandLine("pre-commit"),
  "pre-push": gitHookCommandLine("pre-push"),
} as const;
const guardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const effectGateFallback: Record<EffectGateId, string> = {
  F6: "Skip",
  N1: "Maybe later",
  N2: "Skip",
  O1: "Manual only",
  O2: "No",
  O3: "Just let me know (recommended)",
};
const effectGates = new Set<EffectGateId>(Object.keys(effectGateFallback) as EffectGateId[]);

class OnboardingEffectUnavailableError extends Error {
  constructor(readonly gate: EffectGateId, missing: readonly string[], readonly proof?: string) {
    super(`selected ${gate} effect lacks verified evidence: ${missing.join(", ")}`);
  }
}

const requestedMode = process.argv[2];
const mode = requestedMode ?? (loadOnboardingState(onboardingHome())?.gate === "END" ? "onboard" : "init");
function guardScope(): "repo" | "machine" {
  return loadOnboardingState(onboardingHome())?.scope ?? "machine";
}

function formatOnboardingPretty(payload: {
  gate: string;
  prompt: { question?: string; options?: readonly string[] };
  discovery?: { environments?: Array<{ id?: string; displayName?: string }>; sources?: Array<{ id?: string }> };
}): string {
  const lines: string[] = [];
  if (payload.gate === "A0") {
    lines.push("Hey — I'm VibeBloat.");
    lines.push("");
    lines.push("I'll look through your past coding sessions, find the mistakes your AI keeps");
    lines.push("making, and set up little tripwires so they can't happen again.");
    lines.push("");
    lines.push("One quick look now — about a minute — then I just run quietly in the background.");
    lines.push("");
    lines.push("Want to start?");
  } else if (payload.prompt?.question) {
    // Gates arrive already rendered from this machine's measurements. Stripping
    // brackets off unfilled placeholders used to print one developer's figures
    // as if they were the reader's, which is worse than showing nothing.
    lines.push(payload.prompt.question);
  } else {
    lines.push(`Gate ${payload.gate}.`);
  }
  const discovery = payload.discovery;
  if (discovery && (discovery.environments?.length ?? 0) > 0) {
    const names = (discovery.environments ?? [])
      .map((env) => env.displayName ?? env.id ?? "")
      .filter(Boolean);
    if (names.length > 0) lines.push("", `Found: ${names.join(", ")}.`);
  }
  const options = payload.prompt?.options ?? [];
  if (options.length > 0) {
    lines.push("");
    for (let index = 0; index < options.length; index += 1) {
      lines.push(`  ${index + 1}. ${options[index]}`);
    }
  }
  return lines.join("\n");
}

function disabledGuards(): Set<string> {
  return new Set(guardHomes().flatMap((home) => [...disabledGuardIds(home)]));
}

function runtimeGuards(): Guard[] {
  const installed = guardDirectories().flatMap(loadGuards);
  const builtInIds = new Set(guards.map((guard) => guard.id));
  const seenIds = new Set(builtInIds);
  const duplicate = installed.find((guard) => seenIds.has(guard.id) || !seenIds.add(guard.id));
  if (duplicate) throw new Error(`Installed guard duplicates built-in id: ${duplicate.id}`);
  return [...guards, ...installed];
}

function configText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function defaultOpenAiModelCommand(): string[] {
  return [
    "curl", "-fsS", "-X", "POST", "https://api.openai.com/v1/chat/completions",
    "-H", "Content-Type: application/json",
    "-H", `Authorization: Bearer ${process.env.OPENAI_API_KEY ?? ""}`,
    "-d", "@-",
  ];
}

function defaultLocalModelCommand(): string[] {
  return ["ollama", "run", "llama3.1:8b"];
}

function defaultAgentModelCommand(): string[] | undefined {
  if (process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_CODE_SSE_PORT) {
    return ["claude", "-p", "--model", "claude-opus-4-8"];
  }
  if (process.env.CODEX_HOME) {
    return ["codex", "exec", "--model", "gpt-5"];
  }
  if (process.env.OPENCLAW_SESSION) {
    return ["openclaw", "model", "run"];
  }
  if (process.env.HERMES_HOME) {
    return ["hermes", "agent", "complete"];
  }
  return undefined;
}

function parseModelCommandValue(name: string, value: string): string[] {
  let command: unknown;
  try {
    command = JSON.parse(value);
  } catch {
    command = value.split(/\s+/).filter(Boolean);
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`${name} must be a JSON array or shell-style command string`);
  }
  return command as string[];
}

function modelCommandFromEnvironment(route?: ModelRoute): string[] {
  const preferredName = route ? modelCommandEnvironmentName(route) : undefined;
  const preferredValue = preferredName ? process.env[preferredName] : undefined;
  if (preferredValue) return parseModelCommandValue(preferredName!, preferredValue);
  if (preferredName) {
    if (route === "agent-session") {
      const agent = defaultAgentModelCommand();
      if (agent) return agent;
      throw new Error(`${preferredName} is required for agent-driven scan (or run Vibebloat from inside Claude Code / Codex / OpenClaw / Hermes)`);
    }
    if (route === "api-key" && process.env.OPENAI_API_KEY) return defaultOpenAiModelCommand();
    if (route === "local") return defaultLocalModelCommand();
    throw new Error(`${preferredName} is required for the selected model route (or set OPENAI_API_KEY / install Ollama)`);
  }
  const explicit = process.env.VIBEBLOAT_MODEL_COMMAND;
  if (explicit) return parseModelCommandValue("VIBEBLOAT_MODEL_COMMAND", explicit);
  const agent = defaultAgentModelCommand();
  if (agent) return agent;
  if (process.env.OPENAI_API_KEY) return defaultOpenAiModelCommand();
  if (process.env.VIBEBLOAT_LOCAL_MODEL_COMMAND) {
    return parseModelCommandValue("VIBEBLOAT_LOCAL_MODEL_COMMAND", process.env.VIBEBLOAT_LOCAL_MODEL_COMMAND);
  }
  throw new Error("No model available. Run Vibebloat from inside Claude Code / Codex / OpenClaw / Hermes, set OPENAI_API_KEY, install Ollama, or set VIBEBLOAT_MODEL_COMMAND.");
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function argumentAssignment(flag: string): string | undefined {
  const prefix = `${flag}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

function githubUsername(): string {
  const fromArgument = argumentAssignment("--github-user") ?? process.env.VIBEBLOAT_GITHUB_USER;
  if (fromArgument) return fromArgument;
  const result = Bun.spawnSync(["git", "config", "--get", "github.user"], { stdout: "pipe", stderr: "ignore" });
  const fromGitConfig = result.exitCode === 0 ? result.stdout.toString().trim() : "";
  if (fromGitConfig) return fromGitConfig;
  throw new Error("GitHub username unknown. Pass --github-user=<name> or set VIBEBLOAT_GITHUB_USER.");
}

async function claimStarPackForScope(scope: "repo" | "machine"): Promise<StarPackClaimReport> {
  return claimStarPack(githubUsername(), join(guardHomeForScope(scope), "guards"));
}

function fsGuardCommand(repository: string): string[] {
  const script = process.argv[1] && /\.[cm]?[jt]s$/i.test(process.argv[1]) ? resolve(process.argv[1]) : undefined;
  return script
    ? [process.execPath, script, "watch", repository]
    : [process.execPath, "watch", repository];
}

function agentHomes(): { claudePath: string; codexPath: string; hermesHome: string } {
  const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return {
    claudePath: join(process.env.CLAUDE_CONFIG_DIR ?? join(base, ".claude"), "settings.json"),
    codexPath: join(process.env.CODEX_HOME ?? join(base, ".codex"), "config.toml"),
    hermesHome: process.env.HERMES_HOME ?? join(base, ".hermes"),
  };
}

function installOnboardingDailySchedule(scope: GuardScope): void {
  const userHome = process.env.USERPROFILE ?? process.env.HOME;
  if (!userHome) throw new DailySchedulerTargetUnavailableError();
  installVerifiedStandaloneDailyScheduler({
    home: guardHomeForScope(scope),
    userHome,
    selfCommand: cliSelfCommand(),
  });
}

function hasVerifiedAgentCronTarget(checkpoint: OnboardingCheckpoint | undefined): boolean {
  return checkpoint?.discovery.environments.some(({ id }) => id === "hermes" || id === "openclaw") === true;
}

function gitHookName(value: string | undefined): GitHookName {
  if (value === "pre-commit" || value === "pre-push") return value;
  throw new Error("unsupported Git hook event");
}

function installFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("post-install doctor failed: ")) return message;
  if (message === "fallback installation requires both --fallback-shim-dir and --fallback-git") return message;
  if (message === "fallback paths must be absolute") return message;
  if (message.startsWith("Current directory is not an installable Git repository:")) return "current directory is not an installable Git repository";
  if (message.includes("Hermes")) return "Hermes hook preflight or installation failed";
  if (message.includes("PATH verification")) return "fallback PATH verification failed";
  return "native hook preflight or atomic installation failed";
}

function syncDiffLines(diff: GuardSyncDiff): string {
  const list = (values: readonly string[]) => values.length ? values.join(", ") : "none";
  return [
    `Added: ${list(diff.added)}`,
    `Changed: ${list(diff.changed)}`,
    `Removed: ${list(diff.removed)}`,
  ].join("\n");
}

function syncFailure(error: unknown): string {
  if (!(error instanceof GuardSyncError)) {
    return "WHAT failed: guard sync stopped.\nWHY: guard reload or health verification failed.\nFIX: vibebloat doctor";
  }
  const why = error.what.includes("rollback") || error.what.includes("rolled back")
    ? "candidate guards failed health verification and the previous state was restored"
    : error.what.includes("snapshot") || error.what.includes("validation")
      ? "configured upstream contains an invalid repository guard snapshot"
      : "Git preflight rejected the configured fast-forward guard update";
  const fix = error.fix === "vibebloat doctor" ? error.fix : "git status";
  return `WHAT failed: guard sync stopped.\nWHY: ${why}.\nFIX: ${fix}`;
}

function hookAgent(): GuardAgent {
  const argument = process.argv[3];
  if (!argument) return "claude-code";
  if (argument === "--agent=codex") return "codex";
  if (argument === "--agent=hermes") return "hermes";
  throw new Error("hook agent must be claude-code, codex, or hermes");
}

function readFallbackShellPath(shell: Shell, probe: string): string {
  const command: Record<Shell, string[]> = {
    bash: ["bash", "-lc", probe],
    zsh: ["zsh", "-lc", probe],
    fish: ["fish", "-c", probe],
    pwsh: ["pwsh", "-NoProfile", "-NonInteractive", "-Command", probe],
  };
  const result = Bun.spawnSync(command[shell], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`PATH verification could not run ${shell}: ${result.stderr.toString().trim() || "shell unavailable"}`);
  return result.stdout.toString();
}

function fallbackPathIsHealthy(shimDirectory: string): boolean {
  try {
    verifyShellPaths(shimDirectory, readFallbackShellPath);
    return true;
  } catch {
    return false;
  }
}

function doctorLocalEvidence(home = onboardingHome(), repository = resolve(process.cwd())): {
  sources?: Array<{ id: string; reachable: boolean }>;
  semanticIndex?: { configured: true; lastUpdatedAt: Date };
} {
  const checkpoint = loadOnboardingState(home)?.coordinator;
  const selectedSourceIds = checkpoint?.selectedSourceIds ?? [];
  let sources: Array<{ id: string; reachable: boolean }> | undefined;
  if (selectedSourceIds.length > 0) {
    let reachableIds = new Set<string>();
    try {
      const homes = agentHomes();
      reachableIds = new Set(discoverLocalHistory({
        homeDirectory: process.env.USERPROFILE ?? process.env.HOME ?? ".",
        claudeHome: process.env.CLAUDE_CONFIG_DIR,
        codexHome: process.env.CODEX_HOME,
        hermesHome: homes.hermesHome,
      }).sources.map(({ id }) => id));
    } catch {
      reachableIds = new Set();
    }
    sources = selectedSourceIds.map((id) => ({ id, reachable: reachableIds.has(id) }));
  }
  const indexPath = localSemanticIndexPath(repository, home);
  const semanticIndex = existsSync(indexPath)
    ? { configured: true as const, lastUpdatedAt: statSync(indexPath).mtime }
    : undefined;
  return { sources, semanticIndex };
}

function hermesHookEvidence(hermesHome: string, hermesConfig: string): { expected: boolean; verifiedConfig: string } {
  const hookHome = join(hermesHome, "hooks", "vibebloat");
  const handlerPath = join(hookHome, "handler.py");
  const hookManifest = join(hookHome, "HOOK.yaml");
  const allowlistPath = join(hermesHome, "shell-hooks-allowlist.json");
  let allowlistSource = "";
  try {
    if (existsSync(allowlistPath)) allowlistSource = readFileSync(allowlistPath, "utf8");
  } catch {
    allowlistSource = "";
  }
  const expected = hermesConfig.includes("vibebloat-hermes-pre-tool-call")
    || existsSync(handlerPath)
    || existsSync(hookManifest)
    || allowlistSource.includes("vibebloat-handler-sha=");
  if (!existsSync(handlerPath) || !existsSync(hookManifest) || !allowlistSource) return { expected, verifiedConfig: "" };
  try {
    const digest = createHash("sha256").update(readFileSync(handlerPath)).digest("hex");
    const digestArgument = `--vibebloat-handler-sha=${digest}`;
    const allowlist = JSON.parse(allowlistSource) as { approvals?: unknown[] };
    const approved = Array.isArray(allowlist.approvals) && allowlist.approvals.some((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
      const approval = entry as Record<string, unknown>;
      return approval.event === "pre_tool_call"
        && typeof approval.command === "string"
        && approval.command.includes(handlerPath)
        && approval.command.includes(digestArgument);
    });
    return {
      expected,
      verifiedConfig: approved
        && hermesConfig.includes("vibebloat-hermes-pre-tool-call")
        && hermesConfig.includes(handlerPath)
        && hermesConfig.includes(digestArgument)
        ? hermesConfig
        : "",
    };
  } catch {
    return { expected, verifiedConfig: "" };
  }
}

function verifiedInstalledAgents(hermesExpected: boolean, includeHermes = false): GuardAgent[] {
  const installedAgents: GuardAgent[] = ["claude-code", "codex"];
  if (includeHermes || hermesExpected) installedAgents.push("hermes");
  return installedAgents;
}

function isHistoryChunk(value: unknown): value is HistoryChunk {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const chunk = value as Record<string, unknown>;
  return (chunk.source === "claude-code" || chunk.source === "codex" || chunk.source === "hermes")
    && typeof chunk.sessionId === "string"
    && typeof chunk.messageIndex === "number"
    && typeof chunk.chunkIndex === "number"
    && typeof chunk.role === "string"
    && typeof chunk.content === "string";
}

function parseIncidentManifest(value: unknown): IncidentManifest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const incident = value as Record<string, unknown>;
  if (!(typeof incident.incident_id === "string"
    && (incident.class === "A" || incident.class === "B" || incident.class === "C" || incident.class === "D")
    && (incident.chokepoint === "shell" || incident.chokepoint === "file")
    && typeof incident.condition === "string"
    && Array.isArray(incident.evidence_refs)
    && incident.evidence_refs.every((reference) => typeof reference === "string")
    && typeof incident.severity === "number"
    && typeof incident.frequency === "number"
    && typeof incident.recency === "string")) return undefined;
  return {
    incident_id: incident.incident_id,
    class: incident.class,
    chokepoint: incident.chokepoint,
    ...(typeof incident.command === "string" ? { command: incident.command } : {}),
    ...(typeof incident.path === "string" ? { path: incident.path } : {}),
    ...(incident.args_contains === undefined ? {} : { args_contains: incident.args_contains as string[] }),
    ...(incident.remediation === undefined ? {} : { remediation: incident.remediation as string }),
    condition: incident.condition,
    evidence_refs: incident.evidence_refs,
    severity: incident.severity,
    frequency: incident.frequency,
    recency: incident.recency,
  };
}

type MatchableIncidentManifest = IncidentManifest & (
  | { chokepoint: "shell"; command: string }
  | { chokepoint: "file"; path: string }
);

function isMatchableIncidentManifest(incident: IncidentManifest | undefined): incident is MatchableIncidentManifest {
  if (!incident
    || !incident.incident_id.trim()
    || !incident.condition.trim()
    || incident.evidence_refs.length === 0
    || incident.evidence_refs.some((reference) => !reference.trim())
    || !Number.isFinite(incident.severity) || incident.severity < 0
    || !Number.isFinite(incident.frequency) || incident.frequency < 0
    || !incident.recency.trim()) return false;
  return incident.chokepoint === "shell"
    ? Boolean(incident.command?.trim())
    : Boolean(incident.path?.trim());
}

function assertCompilableIncident(incident: IncidentManifest | undefined): asserts incident is MatchableIncidentManifest {
  if (!isMatchableIncidentManifest(incident)) throw new Error("incident file must contain one safe, matchable incident manifest");
  if (!guardIdPattern.test(incident.incident_id)) throw new Error("incident id must use lower-case kebab-case");
  const canonicalId = canonicalGuardId(incident.incident_id);
  if (canonicalId === "proof" || guards.some((guard) => guard.id === canonicalId)) {
    throw new Error("incident id conflicts with a reserved guard id");
  }
  if (guardDirectories().flatMap(loadGuards).some((guard) => canonicalGuardId(guard.id) === canonicalId)) {
    throw new Error("incident id conflicts with an installed guard");
  }
  // Shared bounds, so a local incident file gets the same limits as model output.
  assertSafeIncident(incident);
}

function hasRawBearerToken(value: unknown): boolean {
  return /\bbearer\s+(?!<redacted>)\S+/i.test(JSON.stringify(value));
}

async function runModelCommand(
  command: readonly string[],
  candidates: HistoryChunk[],
  semanticContext?: UntrustedSemanticContext,
): Promise<IncidentManifest[]> {
  const serialized = serializeModelCommandInput(candidates, semanticContext);
  // The OpenAI route pipes stdin straight into /v1/chat/completions, which
  // rejects the bare candidates payload; it needs a real request body.
  const payload = usesChatCompletionsWire(command) ? buildChatCompletionsBody(serialized) : serialized;
  const result = await executeCommand(command, payload);
  if (result.exitCode !== 0) throw new Error("model command failed");
  const incidents: unknown = parseModelIncidentOutput(result.stdout);
  if (!Array.isArray(incidents) || hasRawBearerToken(incidents)) {
    throw new Error("model command returned an unsafe incident manifest");
  }
  const manifests = incidents.map(parseIncidentManifest);
  if (manifests.some((incident) => incident === undefined)) throw new Error("model command returned an unsafe incident manifest");
  return manifests;
}

function onboardingRunnerContext(
  checkpoint: OnboardingCheckpoint | undefined,
  state: Pick<OnboardingState, "gate" | "reviewDecisions">,
): OnboardingContext {
  const incidentCount = checkpoint?.incidents.length ?? 0;
  const reviewed = state.reviewDecisions?.length ?? 0;
  return {
    knowledgeToolsDetected: false,
    hasHermesOrOpenClaw: checkpoint?.discovery?.environments.some(({ id }) => id === "hermes" || id === "openclaw") ?? false,
    ...(checkpoint?.phase === "review" || checkpoint?.phase === "ready-to-install" || checkpoint?.phase === "ready-to-prove" || checkpoint?.phase === "complete"
      ? { scanOutcome: incidentCount > 0 ? "found" as const : "zero" as const }
      : {}),
    reviewsRemaining: Math.max(1, incidentCount - reviewed + (state.gate === "J3" ? 1 : 0)),
  };
}

function verifiedMissingEnvironmentDirectory(path: string): string {
  if (!isAbsolute(path) || path.length > 4_096 || !existsSync(path)) {
    throw new Error("Missing environment path must be an existing absolute directory.");
  }
  const initial = lstatSync(path);
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw new Error("Missing environment path must be an existing absolute directory.");
  }
  const canonical = realpathSync(path);
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new Error("Missing environment path must be an existing absolute directory.");
  }
  return canonical;
}

function addMissingEnvironment(coordinator: OnboardingCoordinator, home: string, answer: string): void {
  const match = /^(.{1,60}?)\s+(?:at|in)\s+(.+)$/.exec(answer.trim());
  if (!match) throw new Error("Missing environment must be supplied as '<name> at <absolute-directory>'.");
  const label = match[1].trim();
  const path = verifiedMissingEnvironmentDirectory(match[2].trim().replace(/^['"]|['"]$/g, ""));
  const discovery = coordinator.discovery();
  if (!discovery) throw new Error("Environment discovery is unavailable.");
  const environments = new Map(discovery.environments.map((environment) => [environment.id, environment]));
  const customCatalog = discoverLocalHistory({
    homeDirectory: path,
    claudeHome: path,
    codexHome: path,
    hermesHome: path,
  });
  const discoveredSources = customCatalog.sources;
  if (discoveredSources.length === 0) throw new Error("Missing environment directory has no supported Claude, Codex, or Hermes history.");
  for (const source of discoveredSources) {
    saveCustomAgentHome(home, source.id, path);
    environments.set(source.id, { id: source.id, label: discoveredSources.length === 1 ? label : source.label });
  }
  const sources = [
    ...discovery.sources.filter((candidate) => !discoveredSources.some((source) => source.id === candidate.id)),
    ...discoveredSources.map((source) => ({
      id: source.id,
      environmentId: source.id,
      label: `${source.label} history`,
      lastActive: source.lastActivityAt,
      stale: source.stale,
    })),
  ];
  coordinator.reviseDiscovery({ environments: [...environments.values()], sources });
}

function ignoreEnvironments(coordinator: OnboardingCoordinator, home: string, answer: string): void {
  const discovery = coordinator.discovery();
  if (!discovery) throw new Error("Environment discovery is unavailable.");
  const requested = answer.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) throw new Error("At least one discovered environment must be named.");
  const ignored = new Set<string>();
  for (const value of requested) {
    const environment = discovery.environments.find(({ id, label }) => id.toLowerCase() === value || label.toLowerCase() === value);
    if (!environment) throw new Error(`Ignored environment was not discovered: ${value}`);
    ignored.add(environment.id);
  }
  const revokedHomes = [
    ...ignored,
    ...discovery.sources.filter(({ environmentId }) => ignored.has(environmentId)).map(({ id }) => id),
  ];
  revokeCustomAgentHomes(home, revokedHomes);
  coordinator.reviseDiscovery({
    environments: discovery.environments.filter(({ id }) => !ignored.has(id)),
    sources: discovery.sources.filter(({ environmentId }) => !ignored.has(environmentId)),
  });
}

function onboardingBindingSetup(): void {
  const gitHookPaths = discoverCurrentRepoGitHookPaths(process.cwd());
  planGitHook(gitHookPaths["pre-commit"], gitHookCommands["pre-commit"]);
  planGitHook(gitHookPaths["pre-push"], gitHookCommands["pre-push"]);
}

function installVerifiedOnboardingBindings(environmentIds: readonly string[], customHomes: CustomAgentHomes = {}): void {
  const homes = agentHomes();
  const hermesPython = process.env.VIBEBLOAT_HERMES_PYTHON ?? Bun.which("python3") ?? Bun.which("python");
  installOnboardingBindings({
    permitted: true,
    environmentIds,
    repository: resolve(process.cwd()),
    command: "vibebloat hook",
    gitCommands: gitHookCommands,
    claudePath: customHomes["claude-code"] ? join(customHomes["claude-code"], "settings.json") : homes.claudePath,
    codexPath: customHomes.codex ? join(customHomes.codex, "config.toml") : homes.codexPath,
    ...(environmentIds.includes("hermes") && hermesPython
      ? { hermes: { hermesHome: customHomes.hermes ?? homes.hermesHome, pythonExecutable: hermesPython } }
      : {}),
  });
}

function createProductionOnboardingCoordinator(
  home: string,
  resume: OnboardingCheckpoint | undefined,
  save: (checkpoint: OnboardingCheckpoint) => void,
  modelRoute?: ModelRoute,
): OnboardingCoordinator {
  const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  const homes = agentHomes();
  const customHomes = readCustomAgentHomes(home);
  const detectedEnvironments = [
    { id: "claude-code", label: "Claude Code", present: Boolean(customHomes["claude-code"]) || existsSync(dirname(homes.claudePath)) },
    { id: "codex", label: "Codex", present: Boolean(customHomes.codex) || existsSync(dirname(homes.codexPath)) },
    { id: "hermes", label: "Hermes", present: Boolean(customHomes.hermes) || existsSync(homes.hermesHome) },
    { id: "openclaw", label: "OpenClaw", present: existsSync(process.env.OPENCLAW_HOME ?? join(base, ".openclaw")) },
  ].filter(({ present }) => present).map(({ id, label }) => ({ id, label }));
  const historyCatalog = (): LocalHistoryCatalog => {
    const currentCustomHomes = readCustomAgentHomes(home);
    return discoverLocalHistory({
      homeDirectory: base,
      claudeHome: currentCustomHomes["claude-code"] ?? process.env.CLAUDE_CONFIG_DIR,
      codexHome: currentCustomHomes.codex ?? process.env.CODEX_HOME,
      hermesHome: currentCustomHomes.hermes ?? homes.hermesHome,
    });
  };
  return new OnboardingCoordinator({
    resume,
    save,
    cwd: process.cwd(),
    environment: process.env,
    setupBindings: onboardingBindingSetup,
    discover: async () => {
      const sources = historyCatalog().sources;
      const environments = new Map(detectedEnvironments.map((environment) => [environment.id, environment]));
      for (const { id, label } of sources) environments.set(id, { id, label });
      return {
        environments: [...environments.values()],
        sources: sources.map((source) => ({
          id: source.id,
          environmentId: source.id,
          label: `${source.label} history`,
          lastActive: source.lastActivityAt,
          stale: source.stale,
        })),
      };
    },
    verifyScrubbers: () => {
      const resolved = resolveScrubbers();
      return { presidio: resolved.presidio, gitleaks: resolved.gitleaks };
    },
    loadHistory: async (sourceIds, authorization) => historyCatalog().loadConfirmed({
      ...authorization,
      sourceIds: sourceIds as Array<"claude-code" | "codex" | "hermes">,
    }),
    scan: {
      presidioCommand: [],
      gitleaksCommand: [],
      localSink: createLocalOnlySink(join(home, "failed-ingest")),
      semantic: {
        repoRoot: resolve(process.cwd()),
        coordinator: {
          primary: createCodebaseMemorySemanticAdapter(),
          local: createLocalSemanticAdapter({ home }),
        },
      },
      modelPass: async (candidates, semanticContext) => runModelCommand(modelCommandFromEnvironment(modelRoute), candidates, semanticContext),
    },
    incrementalCursor: { directory: join(home, "returning-scan") },
    installBindings: (_guards, environmentIds) => installVerifiedOnboardingBindings(environmentIds, readCustomAgentHomes(home)),
  });
}

async function runProductionReturningScan(
  home: string,
  state: OnboardingState,
  gate: "R1" | "R2" | "R4",
): Promise<{ status: "ingested" | "paused"; chunksScanned: number; incidentsFound: number }> {
  const sourceIds = state.coordinator?.selectedSourceIds;
  if (!sourceIds?.length) {
    const action = gate === "R1" ? "since-last-run problem scan" : gate === "R2" ? "targeted project or tool scan" : "catch-up scan";
    throw new Error(`${action} is unavailable because no durable returning-scan cursor exists.`);
  }
  const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  const homes = agentHomes();
  const catalog = discoverLocalHistory({
    homeDirectory: base,
    claudeHome: process.env.CLAUDE_CONFIG_DIR,
    codexHome: process.env.CODEX_HOME,
    hermesHome: homes.hermesHome,
  });
  const available = new Set(catalog.sources.map(({ id }) => id));
  if (sourceIds.some((id) => !available.has(id as "claude-code" | "codex" | "hermes"))) {
    throw new Error("Returning scan cursor cannot be used because a previously selected history source is unavailable.");
  }
  const scrubbers = resolveScrubbers();
  let incidents: IncidentManifest[] = [];
  const scan = await scanIncrementalHistory({
    directory: join(home, "returning-scan"),
    loadHistory: async () => catalog.loadConfirmed({
      confirmed: true,
      scrubbersVerified: true,
      sourceIds: sourceIds as Array<"claude-code" | "codex" | "hermes">,
    }),
    scan: {
      presidio: scrubbers.presidio,
      gitleaks: scrubbers.gitleaks,
      presidioCommand: [],
      gitleaksCommand: [],
      localSink: createLocalOnlySink(join(home, "failed-ingest")),
      semantic: {
        repoRoot: resolve(process.cwd()),
        coordinator: {
          primary: createCodebaseMemorySemanticAdapter(),
          local: createLocalSemanticAdapter({ home }),
        },
      },
      modelPass: async (candidates, semanticContext) => runModelCommand(modelCommandFromEnvironment(state.preferences?.modelRoute), candidates, semanticContext),
      publish: async (mined) => { incidents = mined; },
    },
  });
  return { ...scan, incidentsFound: rankIncidents(incidents).length };
}

function currentDoctorOptions() {
  const homes = agentHomes();
  const customHomes = readCustomAgentHomes(onboardingHome());
  const hermesHome = customHomes.hermes ?? homes.hermesHome;
  const hermesConfig = configText(join(hermesHome, "config.yaml"));
  const hermesEvidence = hermesHookEvidence(hermesHome, hermesConfig);
  const bindingReceipt = readOnboardingBindingReceipt(resolve(process.cwd()));
  const receiptAgents = bindingReceipt?.environments.map(({ id }) => id)
    .filter((id): id is GuardAgent => id === "claude-code" || id === "codex" || id === "hermes" || id === "openclaw");
  const claudeConfig = configText(customHomes["claude-code"] ? join(customHomes["claude-code"], "settings.json") : homes.claudePath);
  const codexConfig = configText(customHomes.codex ? join(customHomes.codex, "config.toml") : homes.codexPath);
  const detectedAgents: GuardAgent[] = [
    ...(claudeConfig.includes("vibebloat") ? ["claude-code" as const] : []),
    ...(codexConfig.includes("vibebloat") && /plugin_hooks\s*=\s*true/.test(codexConfig) ? ["codex" as const] : []),
    ...(hermesEvidence.expected ? ["hermes" as const] : []),
  ];
  const installedAgents = receiptAgents ?? (detectedAgents.length > 0 ? detectedAgents : ["claude-code", "codex"]);
  const directories = guardDirectories();
  const loadedGuards = runtimeGuards();
  const fallbackShimDirectory = argumentValue("--fallback-shim-dir");
  const filesystemGuardHealth = inspectPersistentFsGuard({ directory: resolve(process.cwd()) });
  const localEvidence = doctorLocalEvidence();
  const options = {
    guardDirectories: directories,
    dataHomes: [...new Set([globalGuardHome(), ...guardHomes()])],
    guards: loadedGuards,
    installedAtByGuard: readInstalledAtByGuard(loadedGuards, directories),
    installedAgents,
    ...localEvidence,
    ...(fallbackShimDirectory ? { fallbackPathHealthy: fallbackPathIsHealthy(resolve(fallbackShimDirectory)) } : {}),
    ...(fallbackShimDirectory || filesystemGuardHealth !== "absent" ? { filesystemGuardHealth } : {}),
    hookConfigs: {
      claude: claudeConfig,
      codex: codexConfig,
      hermes: hermesEvidence.verifiedConfig,
      ...(receiptAgents?.includes("openclaw") ? { openclaw: "vibebloat-openclaw-host-registration" } : {}),
    },
  };
  return {
    options,
    fallbackShimDirectory,
    hasLocalEvidence: Boolean(fallbackShimDirectory
      || filesystemGuardHealth !== "absent"
      || localEvidence.sources?.length
      || localEvidence.semanticIndex),
  };
}

const returningChoiceByAnswer = new Map<string, ReturningChoice>([
  ["Something broke or a new problem", "problem"],
  ["A new project or tool", "project"],
  ["Clean up or change my rules", "manage"],
  ["Just checking in / catch me up", "catch-up"],
]);

function returningPrompt() {
  const base = getReturningGate("R0");
  const activeGuards = runtimeGuards().filter((guard) => !disabledGuards().has(guard.id));
  const firingAudit = readAndPruneFirings(globalGuardHome());
  const firedRules = new Set(firingAudit.events.map(({ guardId }) => guardId)).size;
  return {
    ...base,
    question: `Welcome back. You've got ${activeGuards.length} rules running and ${firedRules} have kicked in recently. What brings you back today?`,
  };
}

if (mode === "onboard") {
  const home = onboardingHome();
  const state = loadOnboardingState(home);
  if (!state || state.gate !== "END") {
    process.stderr.write("WHAT failed: returning onboarding is unavailable.\nWHY: first-run onboarding is not complete.\nFIX: vibebloat init\n");
    process.exit(1);
  }
  const answerIndex = process.argv.indexOf("--answer");
  if (answerIndex < 0) {
    process.stdout.write(`${JSON.stringify({ gate: "R0", prompt: returningPrompt() })}\n`);
    process.exit(0);
  }
  const answer = process.argv[answerIndex + 1] ?? "";
  let choice = returningChoiceByAnswer.get(answer);
  if (!choice) {
    const projectRoot = resolve(import.meta.dir, "..");
    const source = (name: string) => {
      const path = join(projectRoot, name);
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    let appliedOption: string | undefined;
    const assist = answerAssist(answer, {
      ...returningPrompt(),
      faq: (message) => lookupMarkdownAnswer(message, source("FAQ.md")),
      repo: (message) => lookupMarkdownAnswer(message, `${source("README.md")}\n\n${source("ONBOARDING-SPEC.md")}`),
      reasoning: () => "Choose whether to report a problem, add a project, manage rules, or run a catch-up.",
      recommendedOption: "Just checking in / catch me up",
      applyRecommended: (recommended) => { appliedOption = recommended; },
    });
    choice = appliedOption ? returningChoiceByAnswer.get(appliedOption) : undefined;
    if (!choice) {
      process.stdout.write(`${JSON.stringify({ gate: "R0", prompt: returningPrompt(), assist })}\n`);
      process.exit(0);
    }
  }
  const gate = returningRoute(choice);
  try {
    const { options: doctorOptions } = currentDoctorOptions();
    const result = await runReturningService(gate, {
      globalHome: globalGuardHome(),
      guards: runtimeGuards(),
      disabledGuardIds: disabledGuards(),
      doctorOptions,
      dailyOptions: { scope: guardScope() },
      incrementalScan: (returningGate) => runProductionReturningScan(home, state, returningGate),
    });
    saveOnboardingState(home, recordReturningConversation(state, { reason: choice }));
    process.stdout.write(`${JSON.stringify({ gate, result })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: returning action stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat doctor\n`);
    process.exit(1);
  }
}

if (mode === "doctor") {
  try {
    const { options: doctorOptions, fallbackShimDirectory, hasLocalEvidence } = currentDoctorOptions();
    if (installationState(doctorOptions) === "not-installed" && !hasLocalEvidence) {
      process.stdout.write("VibeBloat doctor: not installed.\n");
      process.exit(0);
    }
    const audit = readLastFiredSummaries(globalGuardHome());
    const lastFiredAtByGuard = Object.fromEntries(audit.summaries.map((summary) => [summary.guardId, summary.lastFiredAt]));
    const findings = runDoctor({ ...doctorOptions, lastFiredAtByGuard });
    const errors = findings.filter((finding) => finding.status === "error");
    const warnings = findings.filter((finding) => finding.status === "warning");
    if (errors.length === 0) {
      process.stdout.write("VibeBloat doctor: healthy.\n");
      if (warnings.length > 0) {
        const fix = warnings.some((finding) => finding.check === "index-freshness")
          ? "vibebloat init"
          : "vibebloat disable <guard-id>";
        process.stdout.write(`WHAT needs review: doctor found ${warnings.length} warning(s).\nWHY: ${warnings.map((finding) => finding.message).join(" ")}\nFIX: ${fix}\n`);
      }
      process.exit(0);
    }
    const fix = errors.some((finding) => finding.check === "fallback-path" || finding.check === "filesystem-guard")
      ? "vibebloat install --yes --fallback-shim-dir <absolute-shim-dir> --fallback-git <absolute-git-executable>"
      : errors.some((finding) => finding.check === "source-health")
        ? "vibebloat init"
        : "vibebloat install --yes";
    process.stderr.write(`WHAT failed: doctor found ${errors.length} problem(s).\nWHY: ${errors.map((finding) => finding.message).join(" ")}\nFIX: ${fix}\n`);
    process.exit(1);
  } catch (error) {
    process.stderr.write(`WHAT failed: doctor could not run.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat doctor\n`);
    process.exit(1);
  }
}

if (mode === "stats") {
  try {
    const audit = readAndPruneFirings(globalGuardHome());
    process.stdout.write(`${JSON.stringify(readLocalStats(guardDirectories(), audit.events))}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: local stats could not be read.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat doctor\n`);
    process.exit(1);
  }
}

if (mode === "sync") {
  if (process.argv.length !== 4 || process.argv[3] !== "--pull") {
    process.stderr.write("WHAT failed: sync needs --pull.\nWHY: automatic merge, rebase, force, and push are forbidden.\nFIX: vibebloat sync --pull\n");
    process.exit(1);
  }
  try {
    const plan = fetchAndPlanPull(process.cwd());
    process.stdout.write(`Guard sync: ${plan.commitsBehind} commit(s) behind.\n${syncDiffLines(plan.diff)}\n`);
    const result = applyPull(plan, {
      reload: (directory) => { loadGuards(directory); },
      doctor: () => {
        const homes = agentHomes();
        const repositoryHome = join(plan.repository, ".vibebloat");
        const directories = [...new Set([...guardDirectories(), join(repositoryHome, "guards")])];
        const installed = directories.flatMap(loadGuards);
        const seenIds = new Set(guards.map((guard) => guard.id));
        if (installed.some((guard) => seenIds.has(guard.id) || !seenIds.add(guard.id))) return false;
        const loadedGuards = [...guards, ...installed];
        const installedAgents: GuardAgent[] = ["claude-code", "codex"];
        if (existsSync(homes.hermesHome)) installedAgents.push("hermes");
        return runDoctor({
          guardDirectories: directories,
          dataHomes: [...new Set([globalGuardHome(), ...guardHomes(), repositoryHome])],
          guards: loadedGuards,
          installedAtByGuard: readInstalledAtByGuard(loadedGuards, directories),
          installedAgents,
          hookConfigs: {
            claude: configText(homes.claudePath),
            codex: configText(homes.codexPath),
            hermes: configText(join(homes.hermesHome, "config.yaml")),
          },
        }).every((finding) => finding.status !== "error");
      },
    });
    process.stdout.write(result.applied ? `Synced repository guards at ${result.commit}.\n` : "Repository guards already current.\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${syncFailure(error)}\n`);
    process.exit(1);
  }
}

if (mode === "update") {
  try {
    const apply = parseUpdateArguments(process.argv.slice(3));
    const selfCommand = cliSelfCommand();
    const result = runControlledUpdateCommand({
      apply,
      communityGuardDirectory: join(globalGuardHome(), "guards"),
      currentVersion: packageMetadata.version,
      doctor: () => {
        try {
          return Bun.spawnSync([...selfCommand, "doctor"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
        } catch {
          return false;
        }
      },
      packageRoot: resolve(import.meta.dir, ".."),
      run: (command) => {
        try {
          return Bun.spawnSync([...command], { stdout: "ignore", stderr: "ignore" }).exitCode;
        } catch {
          return 127;
        }
      },
      selfCommand,
    });
    process.stdout.write(formatUpdateCommandResult(result));
    process.exit(0);
  } catch (error) {
    process.stderr.write(formatUpdateCommandFailure(error));
    process.exit(1);
  }
}

if (mode === "email" && process.argv[3] === "--forget") {
  forgetEmail(process.env.VIBEBLOAT_HOME ?? globalGuardHome());
  process.stdout.write("Email removed.\n");
  process.exit(0);
}

if (mode === "star") {
  try {
    const report = await claimStarPackForScope(guardScope());
    process.stdout.write([
      `STAR PACK UNLOCKED  ${report.guardIds.length} guards  repo: ${report.repository}  user: ${report.username}`,
      ...report.guardIds.map((guardId) => `installed: ${guardId}`),
    ].join("\n") + "\n");
    process.exit(0);
  } catch (error) {
    const why = error instanceof Error ? error.message : "unknown error";
    process.stderr.write(`WHAT failed: star pack was not installed.\nWHY: ${why}\nFIX: star the VibeBloat GitHub repo, then rerun vibebloat star --github-user=<name>\n`);
    process.exit(1);
  }
}

if (mode === "install") {
  const homes = agentHomes();
  if (process.argv[3] !== "--yes") {
    process.stderr.write("WHAT failed: setup permission was not confirmed.\nWHY: install changes native agent configuration.\nFIX: vibebloat install --yes\n");
    process.exit(1);
  }
  const legacyHermesFlags = ["--hermes-hooks-dir", "--hermes-config"];
  if (legacyHermesFlags.some((flag) => process.argv.includes(flag))) {
    process.stderr.write("WHAT failed: Hermes setup flags are outdated.\nWHY: VibeBloat must install into Hermes home and approve its canonical config bridge.\nFIX: vibebloat install --yes --hermes-home <path> --hermes-python <path>\n");
    process.exit(1);
  }
  const hermesHomeIndex = process.argv.indexOf("--hermes-home");
  const hermesHome = hermesHomeIndex < 0 ? undefined : process.argv[hermesHomeIndex + 1];
  const hermesPythonIndex = process.argv.indexOf("--hermes-python");
  const hermesPython = hermesPythonIndex < 0 ? undefined : process.argv[hermesPythonIndex + 1];
  if ((hermesHomeIndex >= 0 && (!hermesHome || hermesHome.startsWith("--"))) || (hermesPythonIndex >= 0 && (!hermesPython || hermesPython.startsWith("--")))) {
    process.stderr.write("WHAT failed: Hermes home or Python interpreter was not supplied.\nWHY: VibeBloat must wire Hermes's canonical config with explicit paths.\nFIX: vibebloat install --yes --hermes-home <path> --hermes-python <path>\n");
    process.exit(1);
  }
  if (Boolean(hermesHome) !== Boolean(hermesPython)) {
    process.stderr.write("WHAT failed: Hermes home and Python interpreter must be supplied together.\nWHY: VibeBloat must wire Hermes's canonical config with an explicit interpreter.\nFIX: vibebloat install --yes --hermes-home <path> --hermes-python <path>\n");
    process.exit(1);
  }
  try {
    const gitHookPaths = discoverCurrentRepoGitHookPaths(process.cwd());
    planGitHook(gitHookPaths["pre-commit"], gitHookCommands["pre-commit"]);
    planGitHook(gitHookPaths["pre-push"], gitHookCommands["pre-push"]);
    const fallbackShimDirectory = argumentValue("--fallback-shim-dir");
    const fallbackGitExecutable = argumentValue("--fallback-git");
    if (Boolean(fallbackShimDirectory) !== Boolean(fallbackGitExecutable)) {
      throw new Error("fallback installation requires both --fallback-shim-dir and --fallback-git");
    }
    if (fallbackShimDirectory && (!isAbsolute(fallbackShimDirectory) || !isAbsolute(fallbackGitExecutable!))) {
      throw new Error("fallback paths must be absolute");
    }
    if (hermesHome && hermesPython) preflightHermesHook({ permitted: true, hermesHome, pythonExecutable: hermesPython });
    installNativeHooks({
      permitted: true,
      claudePath: homes.claudePath,
      codexPath: homes.codexPath,
      command: "vibebloat hook",
      ...(fallbackShimDirectory ? {
        fallback: {
          shimDirectory: fallbackShimDirectory,
          gitExecutable: fallbackGitExecutable,
          readPath: readFallbackShellPath,
          selfCommand: cliSelfCommand(),
        },
      } : {}),
    });
    if (hermesHome && hermesPython) installHermesHook({ permitted: true, hermesHome, pythonExecutable: hermesPython });
    installCurrentRepoGitHooks(process.cwd(), gitHookCommands);
    if (fallbackShimDirectory) {
      launchPersistentFsGuard({ directory: resolve(process.cwd()), command: fsGuardCommand(resolve(process.cwd())) });
    }
    const repository = resolve(process.cwd());
    const postInstallHermesHome = hermesHome ?? homes.hermesHome;
    const hermesConfig = configText(join(postInstallHermesHome, "config.yaml"));
    const hermesEvidence = hermesHookEvidence(postInstallHermesHome, hermesConfig);
    const filesystemGuardHealth = inspectPersistentFsGuard({ directory: repository });
    const postInstallFindings = runDoctor({
      requireProof: false,
      guardDirectories: guardDirectories(),
      dataHomes: [...new Set([globalGuardHome(), ...guardHomes()])],
      guards: [],
      installedAgents: verifiedInstalledAgents(hermesEvidence.expected, Boolean(hermesHome)),
      ...doctorLocalEvidence(onboardingHome(), repository),
      ...(fallbackShimDirectory ? { fallbackPathHealthy: fallbackPathIsHealthy(resolve(fallbackShimDirectory)) } : {}),
      ...(fallbackShimDirectory || filesystemGuardHealth !== "absent" ? { filesystemGuardHealth } : {}),
      hookConfigs: {
        claude: configText(homes.claudePath),
        codex: configText(homes.codexPath),
        hermes: hermesEvidence.verifiedConfig,
      },
    });
    const postInstallErrors = postInstallFindings.filter((finding) => finding.status === "error");
    if (postInstallErrors.length > 0) {
      throw new Error(`post-install doctor failed: ${postInstallErrors.map((finding) => finding.message).join(" ")}`);
    }
    process.stdout.write(fallbackShimDirectory
      ? `Native hooks, Git hooks, fallback git shims, and filesystem guard installed. Run: vibebloat doctor\n`
      : "Native hooks and Git hooks installed. Run: vibebloat doctor\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: native hook installation stopped.\nWHY: ${installFailureReason(error)}.\nFIX: vibebloat install --yes\n`);
    process.exit(1);
  }
}

if (mode === "uninstall") {
  if (!process.argv.includes("--yes")) {
    process.stderr.write("WHAT failed: uninstall permission was not confirmed.\nWHY: uninstall changes native agent configuration and local data.\nFIX: vibebloat uninstall --yes\n");
    process.exit(1);
  }
  try {
    const fallbackShimDirectory = argumentValue("--fallback-shim-dir");
    const fallbackGitExecutable = argumentValue("--fallback-git");
    if (Boolean(fallbackShimDirectory) !== Boolean(fallbackGitExecutable)) {
      throw new Error("fallback removal needs both paths");
    }
    if (fallbackShimDirectory && (!isAbsolute(fallbackShimDirectory) || !isAbsolute(fallbackGitExecutable!))) {
      throw new Error("fallback removal paths are not absolute");
    }
    const homes = agentHomes();
    const repository = resolve(process.cwd());
    const gitHookPaths = Object.values(discoverCurrentRepoGitHookPaths(repository));
    const globalHome = process.env.VIBEBLOAT_HOME ?? globalGuardHome();
    const stopReport = stopPersistentFsGuard({ directory: repository });
    let report;
    try {
      report = uninstallVibeBloat({
      permitted: true,
      keepData: process.argv.includes("--keep-data"),
      globalHome,
      repository,
      claudePath: homes.claudePath,
      codexPath: homes.codexPath,
      hermesHome: homes.hermesHome,
      gitHookPaths,
      ...(fallbackShimDirectory ? { shellShim: { directory: fallbackShimDirectory, realGitExecutable: fallbackGitExecutable! } } : {}),
      doctor: () => installationState({
        guardDirectories: [],
        dataHomes: [],
        hookConfigs: {
          claude: configText(homes.claudePath),
          codex: configText(homes.codexPath),
          hermes: configText(join(homes.hermesHome, "config.yaml")),
        },
      }),
      });
    } catch (error) {
      if (stopReport.stopped) {
        try {
          launchPersistentFsGuard({ directory: repository, command: fsGuardCommand(repository) });
        } catch {
          throw new Error("WHAT failed: uninstall rollback stopped.\nWHY: filesystem guard could not be restored after uninstall failed.\nFIX: vibebloat install --yes");
        }
      }
      throw error;
    }
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error && error.message.startsWith("WHAT failed:")
      ? error.message
      : "WHAT failed: uninstall stopped.\nWHY: owned integration preflight or verification failed.\nFIX: vibebloat doctor";
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

if (mode === "init") {
  const home = onboardingHome();
  const stored = loadOnboardingState(home);
  let runnerSource: RunnerDetectionSource | "saved";
  let runnerKind: RunnerState["runner"];
  try {
    const explicit = parseRunnerOverride(process.argv.slice(3));
    const signals = {
      explicit,
      isTTY: Boolean(process.stdin.isTTY),
      env: process.env,
      parentProcess: "",
    };
    const savedRunner = stored?.runner === "agent" || stored?.runner === "human" ? stored.runner : undefined;
    const preliminary = detectRunnerDetails(signals);
    const detected = explicit || savedRunner || preliminary.source === "environment"
      ? preliminary
      : detectRunnerDetails({ ...signals, parentProcess: parentProcessCommand() });
    runnerKind = explicit ?? savedRunner ?? detected.kind;
    runnerSource = explicit ? "explicit" : savedRunner ? "saved" : detected.source;
  } catch (error) {
    process.stderr.write(`WHAT failed: onboarding runner selection stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}.\nFIX: vibebloat init --human\n`);
    process.exit(1);
  }
  const state: OnboardingState = stored
    ? { ...stored, gate: stored.gate as RunnerState["gate"], answers: stored.answers, runner: runnerKind }
    : { gate: "A0", answers: {}, runner: runnerKind };
  let coordinatorCheckpoint = state.coordinator;
  const coordinator = createProductionOnboardingCoordinator(home, coordinatorCheckpoint, (checkpoint) => { coordinatorCheckpoint = checkpoint; }, state.preferences?.modelRoute);
  let runner = new OnboardingRunner(state as RunnerState, onboardingRunnerContext(coordinatorCheckpoint, state), {}, onboardingGateValues(coordinatorCheckpoint));
  const answerIndex = process.argv.indexOf("--answer");
  const prettyMode = process.argv.includes("--pretty");
  if (answerIndex < 0) {
    const payload = { ...runner.snapshot(), runnerSource, prompt: runner.current(), ...(coordinator.discovery() ? { discovery: coordinator.discovery() } : {}) };
    if (prettyMode) {
      process.stdout.write(`${formatOnboardingPretty(payload)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
    process.exit(0);
  }
  const answer = process.argv[answerIndex + 1] ?? "";
  const before = runner.snapshot();
  const directChoice = answer.trim().toLowerCase() === "cancel" || isGateChoice(before.gate, answer);
  let assistResponse: ReturnType<OnboardingRunner["assist"]> | undefined;
  let next: RunnerState;
  if (directChoice) {
    next = runner.choose(answer);
  } else {
    const projectRoot = resolve(import.meta.dir, "..");
    const source = (name: string) => {
      const path = join(projectRoot, name);
      return existsSync(path) ? readFileSync(path, "utf8") : "";
    };
    const recommendedOption = runner.current().options.find((option) => /recommended/i.test(option)) ?? runner.current().options[0];
    assistResponse = runner.assist(answer, {
      faq: (message) => lookupMarkdownAnswer(message, source("FAQ.md")),
      repo: (message) => lookupMarkdownAnswer(message, `${source("README.md")}\n\n${source("ONBOARDING-SPEC.md")}`),
      reasoning: () => "I can explain these locked options, recommend one, or apply the recommended option without skipping this step.",
      recommendedOption,
    });
    next = runner.snapshot();
  }
  if (directChoice && before.gate === "F0" && next.gate === "F0") {
    assistResponse = runner.assist("what do the helpers change?", {
      faq: (message) => {
        const path = join(resolve(import.meta.dir, ".."), "FAQ.md");
        return existsSync(path) ? lookupMarkdownAnswer(message, readFileSync(path, "utf8")) : undefined;
      },
      reasoning: () => "The command helper checks risky shell actions before they run; the Git check protects commits and pushes. Both use owned markers so uninstall can remove only VibeBloat changes.",
    });
  }
  const effectiveAnswer = assistResponse?.appliedOption ?? answer;
  try {
    const validChoice = isGateChoice(before.gate, effectiveAnswer) && !next.cancelled;
    if (validChoice) {
      const effectEvidence: OnboardingEffectEvidence = {};
      const selectedEffectChoice = canonicalGateChoice(before.gate, effectiveAnswer);
      if (before.gate === "O1" && selectedEffectChoice === "Yes") {
        try {
          installOnboardingDailySchedule(next.scope ?? state.scope ?? "machine");
          effectEvidence.dailyScheduleVerified = true;
        } catch (error) {
          const proof = error instanceof DailySchedulerTargetUnavailableError
            ? "O1 requires a verified standalone VibeBloat executable and a verified native scheduler receipt"
            : "O1 could not verify the standalone executable or native scheduler target";
          throw new OnboardingEffectUnavailableError("O1", ["dailyScheduleVerified"], proof);
        }
      }
      if (before.gate === "O2" && selectedEffectChoice === "Yes") {
        if (!hasVerifiedAgentCronTarget(coordinatorCheckpoint)) {
          throw new OnboardingEffectUnavailableError("O2", ["agentCronVerified"], "O2 requires a verified Hermes or OpenClaw environment");
        }
        try {
          installOnboardingDailySchedule(next.scope ?? state.scope ?? "machine");
          effectEvidence.agentCronVerified = true;
        } catch (error) {
          const proof = error instanceof DailySchedulerTargetUnavailableError
            ? "O2 requires a verified standalone VibeBloat executable and a verified native scheduler receipt"
            : "O2 could not verify the standalone executable or native scheduler target";
          throw new OnboardingEffectUnavailableError("O2", ["agentCronVerified"], proof);
        }
      }
      if (before.gate === "N1" && selectedEffectChoice === "Star") {
        try {
          await claimStarPackForScope(next.scope ?? state.scope ?? "machine");
          effectEvidence.githubStarVerified = true;
        } catch (error) {
          const proof = error instanceof Error ? error.message : "GitHub star could not be verified";
          throw new OnboardingEffectUnavailableError("N1", ["githubStarVerified"], proof);
        }
      }
      if (effectGates.has(before.gate as EffectGateId)) {
        const gate = before.gate as EffectGateId;
        const requirement = validateOnboardingEffectRequirements(gate, effectiveAnswer, effectEvidence);
        if (!requirement.ok) throw new OnboardingEffectUnavailableError(gate, requirement.missing);
      }
      const preferences = applyOnboardingPreference(state.preferences, before.gate, effectiveAnswer);
      if (before.gate === "F2" && preferences.modelRoute) modelCommandFromEnvironment(preferences.modelRoute);
      if ((before.gate === "G-empty" || before.gate === "I-zero") && preferences.starterPack) {
        const scope = next.scope ?? state.scope ?? "machine";
        installStarterGuardPack(join(guardHomeForScope(scope), "guards"));
      }
      state.preferences = preferences;
    }
    if (before.gate === "F1" && next.cancelled && coordinator.snapshot().phase === "privacy") coordinator.cancel();
    if (validChoice && before.gate === "A1" && next.scope) coordinator.begin(next.scope);
    if (validChoice && before.gate === "F0" && next.gate === "B1") {
      if (coordinator.snapshot().phase === "entry") coordinator.begin(next.scope ?? before.scope ?? "machine");
      await coordinator.permitSetupAndDiscover(true);
    }
    if (validChoice && before.gate === "B1" && next.gate === "D1") coordinator.confirmEnvironments(true);
    if (validChoice && before.gate === "B1.missing") addMissingEnvironment(coordinator, home, effectiveAnswer);
    if (validChoice && before.gate === "B1.ignore") ignoreEnvironments(coordinator, home, effectiveAnswer);
    if (validChoice && before.gate === "D1" && next.gate === "D1") {
      const requested = argumentAssignment("--sources")?.split(",").map((id) => id.trim()).filter(Boolean);
      const known = new Set((coordinator.discovery()?.sources ?? []).map(({ id }) => id));
      if (!requested || requested.length === 0) throw new Error("D1 source adjustment requires --sources=<discovered-id,...>.");
      if (new Set(requested).size !== requested.length || requested.some((id) => !known.has(id))) throw new Error("D1 source adjustment contains an unknown or duplicate source.");
      state.pendingSourceIds = requested;
    }
    if (validChoice && before.gate === "D1" && next.gate !== "D1") {
      const sources = coordinator.discovery()?.sources ?? [];
      const selected = effectiveAnswer.trim().toLowerCase().includes("everything")
        ? sources.map(({ id }) => id)
        : state.pendingSourceIds ?? sources.filter(({ stale }) => !stale).map(({ id }) => id);
      coordinator.selectSources(selected);
      delete state.pendingSourceIds;
    }
    if (validChoice && before.gate === "F1") coordinator.consent(true);

    if (validChoice && (before.gate === "J1" || before.gate === "J1-unsure")) {
      const incidents = coordinator.incidents();
      const decisions = [...(state.reviewDecisions ?? [])];
      const incident = incidents[decisions.length];
      const decision = incident
        ? reviewDecisionForChoice(before.gate, next.answers[before.gate] ?? "", incident.incident_id)
        : undefined;
      if (decision) {
        decisions.push(decision);
        state.reviewDecisions = decisions;
      }
    }

    if (validChoice && coordinatorCheckpoint && (before.gate === "SCAN" || next.gate === "SCAN")) {
      const scanState = before.gate === "SCAN" ? before : next;
      const scan = await coordinator.scan();
      if (scan.phase === "paused") {
        saveOnboardingState(home, { ...scanState, coordinator: coordinatorCheckpoint, reviewDecisions: state.reviewDecisions });
        throw new ControlledScrubbersUnavailableError();
      }
      runner = new OnboardingRunner(scanState, onboardingRunnerContext(coordinatorCheckpoint, { ...state, gate: scanState.gate }), {}, onboardingGateValues(coordinatorCheckpoint));
      next = runner.advanceAutomaticGates();
    }

    if (validChoice && next.gate === "K") {
      const decisions: GuardReviewDecision[] = state.reviewDecisions ?? [];
      coordinator.review(decisions);
      await coordinator.install();
      runner = new OnboardingRunner(next, onboardingRunnerContext(coordinatorCheckpoint, { ...state, gate: next.gate }), {}, onboardingGateValues(coordinatorCheckpoint));
    }
    if (validChoice && before.gate === "L1") coordinator.prove();
    if (validChoice && !next.cancelled) {
      runner = new OnboardingRunner(next, onboardingRunnerContext(coordinatorCheckpoint, { ...state, gate: next.gate }), {}, onboardingGateValues(coordinatorCheckpoint));
      next = runner.advanceAutomaticGates();
    }
    saveOnboardingState(home, {
      ...next,
      coordinator: coordinatorCheckpoint,
      reviewDecisions: state.reviewDecisions,
      preferences: state.preferences,
      ...(state.pendingSourceIds ? { pendingSourceIds: state.pendingSourceIds } : {}),
    });
  } catch (error) {
    if (error instanceof ControlledScrubbersUnavailableError) {
      process.stderr.write("WHAT failed: onboarding scan blocked before history read.\nWHY: Verified package-controlled scrubber assets are unavailable.\nFIX: install a signed VibeBloat release, then rerun vibebloat init\n");
      process.exit(1);
    }
    if (error instanceof OnboardingEffectUnavailableError) {
      const fix = error.proof?.includes("standalone")
        ? "install a signed VibeBloat release, then rerun vibebloat init"
        : `vibebloat init --answer ${JSON.stringify(effectGateFallback[error.gate])}`;
      process.stderr.write(`WHAT failed: onboarding effect was not activated.\nWHY: ${error.proof ?? error.message}.\nFIX: ${fix}\n`);
      process.exit(1);
    }
    const reason = error instanceof Error ? error.message : "unknown error";
    const modelVariable = reason.match(/^(VIBEBLOAT_[A-Z_]+)/)?.[1];
    process.stderr.write(`WHAT failed: onboarding setup stopped.\nWHY: ${reason}\nFIX: ${modelVariable ? `set ${modelVariable} to a JSON command array, then rerun vibebloat init --answer ${JSON.stringify(effectiveAnswer)}` : "vibebloat init --answer Yes"}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ...next, ...(state.pendingSourceIds ? { pendingSourceIds: state.pendingSourceIds } : {}), runnerSource, prompt: runner.current(), ...(coordinator.discovery() ? { discovery: coordinator.discovery() } : {}), ...(assistResponse ? { assist: assistResponse } : {}) })}\n`);
  process.exit(0);
}

if (mode === "disable") {
  try {
    const guardId = canonicalGuardId(process.argv[3] ?? "");
    disableGuard(guardId, guardHomeForScope(guardScope()));
    process.stdout.write(`Disabled guard: ${guardId}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: could not disable guard.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat disable <guard-id>\n`);
    process.exit(1);
  }
}

if (mode === "allow") {
  const guardId = canonicalGuardId(process.argv[3] ?? "");
  if (process.argv[4] !== "--once" || process.argv.length !== 5) {
    process.stderr.write("WHAT failed: allow needs one guard id and --once.\nWHY: persistent overrides are limited to one matching hook invocation.\nFIX: vibebloat allow <guard-id> --once\n");
    process.exit(1);
  }
  try {
    allowOnce(guardId, guardHomeForScope(guardScope()));
    process.stdout.write(`Allowed once: ${guardId}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: could not allow guard once.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat allow <guard-id> --once\n`);
    process.exit(1);
  }
}

if (mode === "watch") {
  const directory = process.argv[3] ? resolve(process.argv[3]) : undefined;
  if (!directory) {
    process.stderr.write("WHAT failed: watch directory was not supplied.\nWHY: watch needs one directory path.\nFIX: vibebloat watch <directory>\n");
    process.exit(1);
  }
  try {
    const instanceId = argumentAssignment("--vibebloat-fs-guard-instance");
    const receiptPath = argumentAssignment("--vibebloat-fs-guard-receipt");
    const persistent = instanceId !== undefined || receiptPath !== undefined;
    if (persistent && (!instanceId || !receiptPath || process.argv.length !== 6)) {
      throw new Error("persistent filesystem watch lifecycle arguments are incomplete");
    }
    if (!persistent && process.argv.length !== 4) throw new Error("watch accepts exactly one directory path");
    if (persistent) waitForFsGuardLaunchReceipt({ directory, instanceId: instanceId!, receiptPath });
    await new Promise<void>((resolve) => {
      const guards = runtimeGuards();
      const watcher = watchGuardedWrites(directory, guards, (path, response) => {
        process.stderr.write(`WHAT detected: guarded write quarantined.\nWHY: ${response.stderr ?? "filesystem guard rejected the write after the filesystem event."}\nFIX: inspect .vibebloat/quarantine/fs-guard\n`);
      }, new Runtime(disabledGuards()));
      let lifecycleWatcher: ReturnType<typeof watchFsGuardStopRequests> | undefined;
      const close = closeWatcherOnSignals(watcher, process, () => {
        lifecycleWatcher?.close();
        resolve();
      });
      if (persistent) {
        lifecycleWatcher = watchFsGuardStopRequests({ directory, instanceId: instanceId!, receiptPath }, close);
      } else {
        process.stdout.write(hasUnenforceableFileGuard(guards)
          ? `Watching guarded writes in ${directory}. Rejected bytes are quarantined and prior content is restored; native hooks block before writes. Press Ctrl+C to stop.\n`
          : `Watching guarded writes in ${directory}. Press Ctrl+C to stop.\n`);
      }
    });
    process.exit(0);
  } catch (error) {
    process.stderr.write("WHAT failed: filesystem watch could not start.\nWHY: watch path or owned lifecycle handshake failed.\nFIX: vibebloat watch <directory>\n");
    process.exit(1);
  }
}

if (mode === "scan") {
  const historyPath = process.argv[3];
  if (!historyPath) {
    process.stderr.write("WHAT failed: history file was not supplied.\nWHY: scan needs one JSON array of history chunks.\nFIX: vibebloat scan <history.json>\n");
    process.exit(1);
  }
  if (existsSync(historyPath) && lstatSync(historyPath).isDirectory()) {
    process.stderr.write("WHAT failed: scan blocked before history read.\nWHY: the history path is a directory, not a JSON history file.\nFIX: vibebloat scan <history.json>\n");
    process.exit(1);
  }
  try {
    const scrubbers = resolveScrubbers();
    const modelCommand = modelCommandFromEnvironment();
    const parsed: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(isHistoryChunk)) throw new Error("history file must contain valid history chunks");

    const scanHome = process.env.VIBEBLOAT_HOME ?? globalGuardHome();
    let candidateCount = 0;
    let incidents: IncidentManifest[] = [];
    const result = await scanHistory(parsed, {
      presidio: scrubbers.presidio,
      gitleaks: scrubbers.gitleaks,
      presidioCommand: [],
      gitleaksCommand: [],
      localSink: createLocalOnlySink(join(scanHome, "failed-ingest")),
      semantic: {
        repoRoot: resolve(process.cwd()),
        coordinator: {
          primary: createCodebaseMemorySemanticAdapter(),
          local: createLocalSemanticAdapter({ home: scanHome }),
        },
      },
      modelPass: async (candidates, semanticContext) => {
        candidateCount = candidates.length;
        return runModelCommand(modelCommand, candidates, semanticContext);
      },
      publish: async (mined) => { incidents = mined; },
    });
    if (result.status === "paused") {
      process.stderr.write(`WHAT failed: scan paused.\nWHY: ${result.message}\nFIX: repair scrubber commands and rerun vibebloat scan <history.json>\n`);
      process.exit(1);
    }
    const ranked = rankIncidents(incidents);
    process.stdout.write(`${JSON.stringify({
      status: result.status,
      chunks_scanned: parsed.length,
      candidates_scanned: candidateCount,
      incidents_found: ranked.length,
      ranked_incidents: ranked,
    })}\n`);
    process.exit(0);
  } catch (error) {
    if (error instanceof ControlledScrubbersUnavailableError) {
      process.stderr.write("WHAT failed: scan blocked before history read.\nWHY: Verified package-controlled scrubber assets are unavailable.\nFIX: install a signed VibeBloat release, then rerun vibebloat scan <history.json>\n");
    } else {
      process.stderr.write(`WHAT failed: scan could not run.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: set model command, then rerun vibebloat scan <history.json>\n`);
    }
    process.exit(1);
  }
}

if (mode === "compile") {
  const incidentPath = process.argv[3];
  if (incidentPath === "--drain" && process.argv.length === 4) {
    try {
      const scope = guardScope();
      const result = drainQueuedLiveCompilesForScope(scope);
      const liveProposals = drainQueuedLiveProposalsForScope(scope);
      const hasLiveProposals = liveProposals.proposed + liveProposals.queued + liveProposals.failed > 0;
      process.stdout.write(`${JSON.stringify({ status: "drained", scope, ...result, ...(hasLiveProposals ? { live_proposals: liveProposals } : {}) })}\n`);
      process.exit(0);
    } catch {
      process.stderr.write("WHAT failed: compile queue drain stopped.\nWHY: queued compile storage contains an unsafe or unreadable entry.\nFIX: vibebloat doctor\n");
      process.exit(1);
    }
  }
  if (!incidentPath || process.argv.length !== 4) {
    process.stderr.write("WHAT failed: incident manifest was not supplied.\nWHY: compile needs exactly one incident JSON file.\nFIX: vibebloat compile <incident.json>\n");
    process.exit(1);
  }
  try {
    const source: unknown = JSON.parse(readFileSync(incidentPath, "utf8"));
    const incident = parseIncidentManifest(source);
    if (hasRawBearerToken(source)) throw new Error("incident file must contain one safe, matchable incident manifest");
    assertCompilableIncident(incident);

    const scope = guardScope();
    const guard = compileGuard(incident, incident.severity >= 4 ? "high" : "low");
    const result = compileLiveForScope(scope, guard, syntheticEvent(guard), process.env, process.cwd(), { trigger: "session-end" });
    const directory = join(guardHomeForScope(scope), "guards");
    if (result.status === "queued") {
      process.stdout.write(`${JSON.stringify({ status: result.status, scope, warning: result.warning })}\n`);
      process.exit(0);
    }
    if (result.status !== "pass") throw new Error("synthetic proof did not fire");

    process.stdout.write(`${JSON.stringify({ status: result.status, scope, path: join(directory, `${guard.id}.json`), proof_path: join(directory, "proof.json") })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: guard compilation stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: correct <incident.json>, then run vibebloat compile <incident.json>\n`);
    process.exit(1);
  }
}

if (mode === "approve-live") {
  const incidentId = process.argv[3];
  if (!incidentId || process.argv.length !== 4) {
    process.stderr.write("WHAT failed: live incident approval was not supplied.\nWHY: approval needs exactly one reviewed incident id.\nFIX: vibebloat approve-live <incident-id>\n");
    process.exit(1);
  }
  try {
    const scope = guardScope();
    const review = reviewLiveCompileProposal(incidentId, { scope });
    const approval = authorizeHumanLiveCompileApproval(incidentId, review.guardSha256, {
      isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      env: process.env,
      parentProcess: parentProcessCommand(),
    });
    process.stdout.write(`${JSON.stringify({ incident_id: review.incidentId, guard: review.guard, guard_sha256: review.guardSha256 }, null, 2)}\n`);
    if (prompt("Install this reviewed guard? Type yes to approve:")?.trim().toLowerCase() !== "yes") throw new Error("Human approval was not confirmed.");
    const result = approveLiveCompileProposal(approval, { scope });
    process.stdout.write(`${JSON.stringify({ ...result, scope, incident_id: incidentId })}\n`);
    process.exit(0);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    const fix = reason === "Live compile proposal is incomplete." ? "vibebloat compile --drain" : "review the proposal, then run vibebloat approve-live <incident-id>";
    process.stderr.write(`WHAT failed: live guard approval stopped.\nWHY: ${reason}\nFIX: ${fix}\n`);
    process.exit(1);
  }
}

if (mode === "live-compile-worker") {
  const incidentId = process.argv[3];
  const scope = process.argv[4];
  if (!incidentId || (scope !== "repo" && scope !== "machine") || process.argv.length !== 5) process.exit(1);
  let result = processQueuedLiveProposal(incidentId, { scope });
  for (let retry = 0; result.status === "queued" && retry < 3; retry += 1) {
    await Bun.sleep(250 * (2 ** retry));
    result = processQueuedLiveProposal(incidentId, { scope });
  }
  process.exit(result.status === "failed" ? 1 : 0);
}

if (mode === "shell-shim") {
  const [gitExecutable, ...arguments_] = process.argv.slice(3);
  process.exit(runShellShimCommand(gitExecutable, arguments_, { cliCommand: cliSelfCommand() }));
}

if (mode === "git-hook") {
  let response;
  try {
    const hook = gitHookName(process.argv[3]);
    if (process.argv.length !== 4) throw new Error("unexpected Git hook arguments");
    const event: Event = { chokepoint: "shell", command: hook === "pre-commit" ? "git commit" : "git push" };
    const verdict = new Runtime(
      disabledGuards(),
      (guardId) => consumeAllowedOnce(guardId, guardHomeForScope(guardScope())),
      undefined,
      createFiringRecorder(globalGuardHome()),
    ).evaluate(runtimeGuards(), event);
    response = hookResponseForVerdict(verdict);
  } catch {
    process.stderr.write("WHAT failed: Git hook evaluation stopped.\nWHY: installed guards or Git hook arguments could not be evaluated.\nFIX: vibebloat doctor\n");
    process.exit(1);
  }
  if (response.stderr) process.stderr.write(`${response.stderr}\n`);
  if (response.localWarning) process.stderr.write(`${response.localWarning}\n`);
  process.exit(response.exitCode);
}

if (mode === "daily") {
  try {
    if (process.argv.length !== 3) throw new Error("unexpected daily arguments");
    const { report } = runDailyStrengtheningCommand({ scope: guardScope() });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exit(0);
  } catch {
    process.stderr.write(formatDailyStrengtheningFailure());
    process.exit(1);
  }
}

if (mode === "rules") {
  try {
    if (process.argv.length !== 3) throw new Error("unexpected rules arguments");
    process.stdout.write(`${JSON.stringify(summarizeRules(runtimeGuards(), disabledGuards()))}\n`);
    process.exit(0);
  } catch {
    process.stderr.write(`${formatGuardRuntimeFailure("rule listing stopped")}\n`);
    process.exit(1);
  }
}

const input = await Bun.stdin.text();

if (mode === "eval") {
  try {
    const { guard, event } = JSON.parse(input) as { guard: Guard; event: Event };
    process.stdout.write(`${JSON.stringify(match(parseGuard(guard), event))}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: eval input could not be processed.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: provide a guard and event JSON object\n`);
    process.exit(1);
  }
}

if (mode === "hook") {
  let response;
  try {
    response = runPreToolUse(runtimeGuards(), JSON.parse(input), new Runtime(
      disabledGuards(),
      (guardId) => consumeAllowedOnce(guardId, guardHomeForScope(guardScope())),
      undefined,
      createFiringRecorder(globalGuardHome()),
    ), hookAgent());
  } catch {
    response = { exitCode: 2 as const, stderr: formatGuardRuntimeFailure("guard hook evaluation stopped") };
  }
  if (response.exitCode === 2 && process.argv[3] === "--agent=codex") {
    if (response.localWarning) process.stderr.write(`${response.localWarning}\n`);
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: response.stderr,
      },
    })}\n`);
    process.exit(0);
  }
  if (response.stderr) process.stderr.write(`${response.stderr}\n`);
  if (response.localWarning) process.stderr.write(`${response.localWarning}\n`);
  process.exit(response.exitCode);
}

if (mode === "scrub") {
  const scrubber = process.argv[3];
  if (scrubber !== "presidio" && scrubber !== "gitleaks") {
    process.stderr.write(`WHAT failed: scrub target must be presidio or gitleaks.\nWHY: received '${scrubber ?? ""}'.\nFIX: vibebloat scrub presidio|gitleaks --json\n`);
    process.exit(2);
  }
  const input = await Bun.stdin.text();
  let text: string;
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed === "string") {
      text = parsed;
    } else if (parsed && typeof parsed === "object" && typeof parsed.payload === "string") {
      text = parsed.payload;
    } else {
      text = input;
    }
  } catch {
    text = input;
  }
  const patterns: Array<{ name: string; re: RegExp; replace: string }> = [
    { name: "bearer", re: /Bearer\s+\S+/gi, replace: "Bearer <redacted>" },
    { name: "api_key", re: /\b(?:sk-[A-Za-z0-9_-]{20,}|api[_-]?key=[A-Za-z0-9_.-]+)\b/gi, replace: "api_key=<redacted>" },
    { name: "password", re: /\bpassword\s*[:=]\s*\S+/gi, replace: "password=<redacted>" },
    { name: "token", re: /\btoken\s*[:=]\s*\S+/gi, replace: "token=<redacted>" },
    { name: "email", re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replace: "<redacted-email>" },
    { name: "absolute_path", re: /\b[A-Z]:\\[^\s"'`<>|]+/gi, replace: "<absolute-path>" },
    { name: "absolute_path_unix", re: /(^|[\s("'`])(?:\/[\w.\-]+)+\/?/g, replace: "$1<absolute-path>" },
  ];
  let cleaned = text;
  const findings: Array<{ name: string; count: number }> = [];
  for (const p of patterns) {
    const matches = cleaned.match(p.re);
    if (matches && matches.length > 0) {
      findings.push({ name: p.name, count: matches.length });
      cleaned = cleaned.replace(p.re, p.replace);
    }
  }
  process.stdout.write(JSON.stringify({ payload: cleaned, findings }));
  process.exit(0);
}

if (mode === "__distribution_probe__") {
  process.stdout.write("vibebloat:dist:ok\n");
  process.exit(0);
}

process.stderr.write("WHAT failed: expected allow, compile, eval, hook, git-hook, disable, doctor, init, onboard, install, uninstall, update, scan, star, stats, sync, watch, daily, rules, or email, scrub, or __distribution_probe__.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
process.exit(1);
