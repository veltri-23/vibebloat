import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createFiringRecorder, readAndPruneFirings, readLastFiredSummaries } from "./audit/firings";
import { disableGuard, disabledGuardIds } from "./cli/disable";
import { installationState, readInstalledAtByGuard, runDoctor } from "./doctor/checks";
import { globalGuardHome, guardDirectories, guardHomeForScope, guardHomes, onboardingHome } from "./guard-home";
import { loadGuards } from "./guard-loader";
import { forgetEmail } from "./growth/email-capture";
import { canonicalGuardId, gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "./guards";
import { formatGuardRuntimeFailure, hookResponseForVerdict, runPreToolUse } from "./hooks";
import { match } from "./match";
import { closeWatcherOnSignals, hasUnenforceableFileGuard, watchGuardedWrites } from "./install/fs-guard";
import { discoverCurrentRepoGitHookPaths, installCurrentRepoGitHooks, planGitHook, type GitHookName } from "./install/git-hooks";
import { installNativeHooks } from "./install/orchestrator";
import { installHermesHook, preflightHermesHook } from "./install/hermes";
import type { Shell } from "./install/shim";
import { compileGuard } from "./compiler/codex-fill";
import { compileLiveForScope, drainQueuedLiveCompilesForScope } from "./compiler/live-compile";
import { createCodebaseMemorySemanticAdapter } from "./ingest/codebase-memory-semantic";
import { createLocalSemanticAdapter } from "./ingest/local-semantic";
import { scanHistory } from "./ingest/scan";
import type { UntrustedSemanticContext } from "./ingest/semantic-context";
import { rankIncidents, type IncidentManifest } from "./ingest/rank";
import type { HistoryChunk } from "./ingest/types";
import { serializeModelCommandInput } from "./mine/model-command-input";
import { detectRunnerDetails, parentProcessCommand, parseRunnerOverride, type RunnerDetectionSource } from "./onboarding/detect-runner";
import { isGateChoice } from "./onboarding/gates";
import { OnboardingRunner, type RunnerState } from "./onboarding/runner";
import { loadOnboardingState, saveOnboardingState } from "./onboarding/state";
import { Runtime } from "./runtime";
import { allowOnce, consumeAllowedOnce } from "./runtime/override";
import { parseGuard } from "./schema";
import { executeCommand } from "./scrub/command";
import { ControlledScrubbersUnavailableError, resolveControlledScrubberCommands } from "./scrub/controlled-release";
import { createLocalOnlySink } from "./scrub/local-sink";
import { readLocalStats } from "./stats/local";
import type { Event, Guard, GuardAgent } from "./types";
import { uninstallVibeBloat } from "./uninstall";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];
const gitHookCommands = {
  "pre-commit": "vibebloat git-hook pre-commit",
  "pre-push": "vibebloat git-hook pre-push",
} as const;
const guardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const mode = process.argv[2] ?? "init";
function guardScope(): "repo" | "machine" {
  return loadOnboardingState(onboardingHome())?.scope ?? "machine";
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

function modelCommandFromEnvironment(): string[] {
  const name = "VIBEBLOAT_MODEL_COMMAND";
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  let command: unknown;
  try {
    command = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON command array`);
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`${name} must be a non-empty JSON command array`);
  }
  return command;
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function agentHomes(): { claudePath: string; codexPath: string; hermesHome: string } {
  const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  return {
    claudePath: join(process.env.CLAUDE_CONFIG_DIR ?? join(base, ".claude"), "settings.json"),
    codexPath: join(process.env.CODEX_HOME ?? join(base, ".codex"), "config.toml"),
    hermesHome: process.env.HERMES_HOME ?? join(base, ".hermes"),
  };
}

function gitHookName(value: string | undefined): GitHookName {
  if (value === "pre-commit" || value === "pre-push") return value;
  throw new Error("unsupported Git hook event");
}

function installFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message === "fallback installation requires both --fallback-shim-dir and --fallback-git") return message;
  if (message === "fallback paths must be absolute") return message;
  if (message.startsWith("Current directory is not an installable Git repository:")) return "current directory is not an installable Git repository";
  if (message.includes("Hermes")) return "Hermes hook preflight or installation failed";
  if (message.includes("PATH verification")) return "fallback PATH verification failed";
  return "native hook preflight or atomic installation failed";
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
}

function hasRawBearerToken(value: unknown): boolean {
  return /\bbearer\s+(?!<redacted>)\S+/i.test(JSON.stringify(value));
}

async function runModelCommand(
  command: readonly string[],
  candidates: HistoryChunk[],
  semanticContext?: UntrustedSemanticContext,
): Promise<IncidentManifest[]> {
  const result = await executeCommand(command, serializeModelCommandInput(candidates, semanticContext));
  if (result.exitCode !== 0) throw new Error("model command failed");
  const incidents: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(incidents) || hasRawBearerToken(incidents)) {
    throw new Error("model command returned an unsafe incident manifest");
  }
  const manifests = incidents.map(parseIncidentManifest);
  if (manifests.some((incident) => incident === undefined)) throw new Error("model command returned an unsafe incident manifest");
  return manifests;
}

if (mode === "doctor") {
  try {
    const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(base, ".claude");
    const codexHome = process.env.CODEX_HOME ?? join(base, ".codex");
    const hermesHome = process.env.HERMES_HOME ?? join(base, ".hermes");
    const installedAgents: GuardAgent[] = ["claude-code", "codex"];
    if (existsSync(hermesHome)) installedAgents.push("hermes");
    if (process.env.OPENCLAW_SESSION) installedAgents.push("openclaw");
    const directories = guardDirectories();
    const loadedGuards = runtimeGuards();
    const doctorOptions = {
      guardDirectories: directories,
      dataHomes: [...new Set([globalGuardHome(), ...guardHomes()])],
      guards: loadedGuards,
      installedAtByGuard: readInstalledAtByGuard(loadedGuards, directories),
      installedAgents,
      hookConfigs: {
        claude: configText(join(claudeHome, "settings.json")),
        codex: configText(join(codexHome, "config.toml")),
        hermes: configText(join(hermesHome, "config.yaml")),
      },
    };
    if (installationState(doctorOptions) === "not-installed") {
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
        process.stdout.write(`WHAT needs review: doctor found ${warnings.length} stale guard(s).\nWHY: ${warnings.map((finding) => finding.message).join(" ")}\nFIX: inspect guard provenance; run vibebloat disable <guard-id> for obsolete guards.\n`);
      }
      process.exit(0);
    }
    process.stderr.write(`WHAT failed: doctor found ${errors.length} problem(s).\nWHY: ${errors.map((finding) => finding.message).join(" ")}\nFIX: vibebloat install --yes\n`);
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

if (mode === "email" && process.argv[3] === "--forget") {
  forgetEmail(process.env.VIBEBLOAT_HOME ?? globalGuardHome());
  process.stdout.write("Email removed.\n");
  process.exit(0);
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
        },
      } : {}),
    });
    if (hermesHome && hermesPython) installHermesHook({ permitted: true, hermesHome, pythonExecutable: hermesPython });
    installCurrentRepoGitHooks(process.cwd(), gitHookCommands);
    process.stdout.write(fallbackShimDirectory
      ? `Native hooks, Git hooks, and fallback git shims installed. Add ${fallbackShimDirectory} first on PATH in each shell, then run: vibebloat doctor\n`
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
    const report = uninstallVibeBloat({
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
  const state: RunnerState = stored
    ? { gate: stored.gate as RunnerState["gate"], answers: stored.answers, runner: runnerKind, scope: stored.scope, cancelled: stored.cancelled }
    : { gate: "A0", answers: {}, runner: runnerKind };
  const runner = new OnboardingRunner(state);
  const answerIndex = process.argv.indexOf("--answer");
  if (answerIndex < 0) {
    process.stdout.write(`${JSON.stringify({ ...runner.snapshot(), runnerSource, prompt: runner.current() })}\n`);
    process.exit(0);
  }
  const answer = process.argv[answerIndex + 1] ?? "";
  const before = runner.snapshot();
  let next = runner.choose(answer);
  try {
    if (before.gate === "F0" && next.gate === "B1") {
      const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
      const gitHookPaths = discoverCurrentRepoGitHookPaths(process.cwd());
      planGitHook(gitHookPaths["pre-commit"], gitHookCommands["pre-commit"]);
      planGitHook(gitHookPaths["pre-push"], gitHookCommands["pre-push"]);
      installNativeHooks({
        permitted: true,
        claudePath: join(process.env.CLAUDE_CONFIG_DIR ?? join(base, ".claude"), "settings.json"),
        codexPath: join(process.env.CODEX_HOME ?? join(base, ".codex"), "config.toml"),
        command: "vibebloat hook",
      });
      installCurrentRepoGitHooks(process.cwd(), gitHookCommands);
    }
    if (isGateChoice(before.gate, answer) && !next.cancelled) next = runner.advanceAutomaticGates();
    saveOnboardingState(home, next);
  } catch (error) {
    process.stderr.write(`WHAT failed: onboarding setup stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat init --answer Yes\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ...next, runnerSource, prompt: runner.current() })}\n`);
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
  const directory = process.argv[3];
  if (!directory) {
    process.stderr.write("WHAT failed: watch directory was not supplied.\nWHY: watch needs one directory path.\nFIX: vibebloat watch <directory>\n");
    process.exit(1);
  }
  try {
    await new Promise<void>((resolve) => {
      const guards = runtimeGuards();
      const watcher = watchGuardedWrites(directory, guards, (path, response) => {
        process.stderr.write(`WHAT detected: guarded write at ${path}.\nWHY: ${response.stderr ?? "filesystem guard matched after the write."}\nFIX: use a native pre-write guard.\n`);
      }, new Runtime(disabledGuards()));
      closeWatcherOnSignals(watcher, process, resolve);
      process.stdout.write(hasUnenforceableFileGuard(guards)
        ? `Watching guarded writes in ${directory}. File guards report after writes; native hooks enforce before writes. Press Ctrl+C to stop.\n`
        : `Watching guarded writes in ${directory}. Press Ctrl+C to stop.\n`);
    });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: filesystem watch could not start.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat watch <directory>\n`);
    process.exit(1);
  }
}

if (mode === "scan") {
  const historyPath = process.argv[3];
  if (!historyPath) {
    process.stderr.write("WHAT failed: history file was not supplied.\nWHY: scan needs one JSON array of history chunks.\nFIX: vibebloat scan <history.json>\n");
    process.exit(1);
  }
  try {
    const scrubbers = resolveControlledScrubberCommands();
    const modelCommand = modelCommandFromEnvironment();
    const parsed: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(isHistoryChunk)) throw new Error("history file must contain valid history chunks");

    const scanHome = process.env.VIBEBLOAT_HOME ?? globalGuardHome();
    let candidateCount = 0;
    let incidents: IncidentManifest[] = [];
    const result = await scanHistory(parsed, {
      presidioCommand: scrubbers.presidio,
      gitleaksCommand: scrubbers.gitleaks,
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
    const scope = guardScope();
    const result = drainQueuedLiveCompilesForScope(scope);
    process.stdout.write(`${JSON.stringify({ status: "drained", scope, ...result })}\n`);
    process.exit(0);
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
    const syntheticEvent: Event = incident.chokepoint === "shell"
      ? { chokepoint: "shell", command: incident.command }
      : { chokepoint: "file", path: incident.path };
    const result = compileLiveForScope(scope, guard, syntheticEvent, process.env, process.cwd(), { trigger: "session-end" });
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

process.stderr.write("WHAT failed: expected allow, compile, eval, hook, git-hook, disable, doctor, init, install, uninstall, scan, stats, watch, or email.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
process.exit(1);
