import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { disableGuard, disabledGuardIds } from "./cli/disable";
import { runDoctor } from "./doctor/checks";
import { globalGuardHome, guardDirectories, guardHomeForScope, guardHomes, onboardingHome } from "./guard-home";
import { loadGuards } from "./guard-loader";
import { forgetEmail } from "./growth/email-capture";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "./guards";
import { runPreToolUse } from "./hooks";
import { closeWatcherOnSignals, watchGuardedWrites } from "./install/fs-guard";
import { installNativeHooks } from "./install/orchestrator";
import { installHermesHook } from "./install/hermes";
import type { Shell } from "./install/shim";
import { scanHistory } from "./ingest/scan";
import { rankIncidents, type IncidentManifest } from "./ingest/rank";
import type { HistoryChunk } from "./ingest/types";
import { isGateChoice } from "./onboarding/gates";
import { OnboardingRunner, type RunnerState } from "./onboarding/runner";
import { loadOnboardingState, saveOnboardingState } from "./onboarding/state";
import { Runtime } from "./runtime";
import { executeCommand } from "./scrub/command";
import { createLocalOnlySink } from "./scrub/local-sink";
import type { Event, Guard } from "./types";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];
const mode = process.argv[2];
const scrubberCommands = {
  VIBEBLOAT_PRESIDIO_COMMAND: ["presidio-wrapper", "--json"],
  VIBEBLOAT_GITLEAKS_COMMAND: ["gitleaks-wrapper", "--json"],
} as const;

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

function commandFromEnvironment(name: string): string[] {
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
  const trusted = scrubberCommands[name as keyof typeof scrubberCommands];
  if (trusted && (command.length !== trusted.length || command.some((part, index) => part !== trusted[index]))) {
    throw new Error(`${name} must use the installed ${trusted[0]} command`);
  }
  return trusted ? [...trusted] : command;
}

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
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

function hasRawBearerToken(value: unknown): boolean {
  return /\bbearer\s+(?!<redacted>)\S+/i.test(JSON.stringify(value));
}

async function runModelCommand(command: readonly string[], candidates: HistoryChunk[]): Promise<IncidentManifest[]> {
  const result = await executeCommand(command, JSON.stringify({ candidates }));
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
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex");
  const findings = runDoctor({
    guardDirectories: guardDirectories(),
    hookConfigs: { claude: configText(join(claudeHome, "settings.json")), codex: configText(join(codexHome, "config.toml")) },
  });
  if (findings.length === 0) {
    process.stdout.write("VibeBloat doctor: healthy.\n");
    process.exit(0);
  }
  process.stderr.write(`WHAT failed: doctor found ${findings.length} problem(s).\nWHY: ${findings.map((finding) => finding.message).join(" ")}\nFIX: vibebloat install\n`);
  process.exit(1);
}

if (mode === "email" && process.argv[3] === "--forget") {
  forgetEmail(process.env.VIBEBLOAT_HOME ?? globalGuardHome());
  process.stdout.write("Email removed.\n");
  process.exit(0);
}

if (mode === "install") {
  const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(base, ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(base, ".codex");
  if (process.argv[3] !== "--yes") {
    process.stderr.write("WHAT failed: setup permission was not confirmed.\nWHY: install changes native agent configuration.\nFIX: vibebloat install --yes\n");
    process.exit(1);
  }
  const hermesHooksDirectoryIndex = process.argv.indexOf("--hermes-hooks-dir");
  const hermesHooksDirectory = hermesHooksDirectoryIndex < 0 ? undefined : process.argv[hermesHooksDirectoryIndex + 1];
  if (hermesHooksDirectoryIndex >= 0 && !hermesHooksDirectory) {
    process.stderr.write("WHAT failed: Hermes hooks directory was not supplied.\nWHY: Hermes installation needs an explicit writable hooks path.\nFIX: vibebloat install --yes --hermes-hooks-dir <path>\n");
    process.exit(1);
  }
  try {
    const fallbackShimDirectory = argumentValue("--fallback-shim-dir");
    const fallbackGitExecutable = argumentValue("--fallback-git");
    if (Boolean(fallbackShimDirectory) !== Boolean(fallbackGitExecutable)) {
      throw new Error("fallback installation requires both --fallback-shim-dir and --fallback-git");
    }
    if (fallbackShimDirectory && (!isAbsolute(fallbackShimDirectory) || !isAbsolute(fallbackGitExecutable!))) {
      throw new Error("fallback paths must be absolute");
    }
    installNativeHooks({
      permitted: true,
      claudePath: join(claudeHome, "settings.json"),
      codexPath: join(codexHome, "config.toml"),
      command: "vibebloat hook",
      ...(fallbackShimDirectory ? {
        fallback: {
          shimDirectory: fallbackShimDirectory,
          gitExecutable: fallbackGitExecutable,
          gitHookPaths: [],
          readPath: readFallbackShellPath,
        },
      } : {}),
    });
    if (hermesHooksDirectory) installHermesHook({ permitted: true, hooksDirectory: hermesHooksDirectory });
    process.stdout.write(fallbackShimDirectory
      ? `Native hooks and fallback git shims installed. Add ${fallbackShimDirectory} first on PATH in each shell, then run: vibebloat doctor\n`
      : "Native hooks installed. Run: vibebloat doctor\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: native hook installation stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat install --yes\n`);
    process.exit(1);
  }
}

if (mode === "init") {
  const home = onboardingHome();
  const stored = loadOnboardingState(home);
  const state: RunnerState = stored
    ? { gate: stored.gate as RunnerState["gate"], answers: stored.answers, scope: stored.scope, cancelled: stored.cancelled }
    : { gate: "A0", answers: {} };
  const runner = new OnboardingRunner(state);
  const answerIndex = process.argv.indexOf("--answer");
  if (answerIndex < 0) {
    process.stdout.write(`${JSON.stringify({ ...runner.snapshot(), prompt: runner.current() })}\n`);
    process.exit(0);
  }
  const answer = process.argv[answerIndex + 1] ?? "";
  const before = runner.snapshot();
  let next = runner.choose(answer);
  try {
    if (before.gate === "F0" && next.gate === "B1") {
      const base = process.env.USERPROFILE ?? process.env.HOME ?? ".";
      installNativeHooks({
        permitted: true,
        claudePath: join(process.env.CLAUDE_CONFIG_DIR ?? join(base, ".claude"), "settings.json"),
        codexPath: join(process.env.CODEX_HOME ?? join(base, ".codex"), "config.toml"),
        command: "vibebloat hook",
      });
    }
    if (isGateChoice(before.gate, answer) && !next.cancelled) next = runner.advanceAutomaticGates();
    saveOnboardingState(home, next);
  } catch (error) {
    process.stderr.write(`WHAT failed: onboarding setup stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat init --answer Yes\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ ...next, prompt: runner.current() })}\n`);
  process.exit(0);
}

if (mode === "disable") {
  try {
    disableGuard(process.argv[3] ?? "", guardHomeForScope(guardScope()));
    process.stdout.write(`Disabled guard: ${process.argv[3]}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: could not disable guard.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat disable <guard-id>\n`);
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
      const watcher = watchGuardedWrites(directory, runtimeGuards(), (path, response) => {
        process.stderr.write(`WHAT detected: guarded write at ${path}.\nWHY: ${response.stderr ?? "filesystem guard matched after the write."}\nFIX: use a native pre-write guard.\n`);
      }, new Runtime(disabledGuards()));
      closeWatcherOnSignals(watcher, process, resolve);
      process.stdout.write(`Watching guarded writes in ${directory}. Press Ctrl+C to stop.\n`);
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
    const presidioCommand = commandFromEnvironment("VIBEBLOAT_PRESIDIO_COMMAND");
    const gitleaksCommand = commandFromEnvironment("VIBEBLOAT_GITLEAKS_COMMAND");
    const modelCommand = commandFromEnvironment("VIBEBLOAT_MODEL_COMMAND");
    const parsed: unknown = JSON.parse(readFileSync(historyPath, "utf8"));
    if (!Array.isArray(parsed) || !parsed.every(isHistoryChunk)) throw new Error("history file must contain valid history chunks");

    let candidateCount = 0;
    let incidents: IncidentManifest[] = [];
    const result = await scanHistory(parsed, {
      presidioCommand,
      gitleaksCommand,
      localSink: createLocalOnlySink(join(process.env.VIBEBLOAT_HOME ?? globalGuardHome(), "failed-ingest")),
      modelPass: async (candidates) => {
        candidateCount = candidates.length;
        return runModelCommand(modelCommand, candidates);
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
    process.stderr.write(`WHAT failed: scan could not run.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: set scrubber and model commands, then rerun vibebloat scan <history.json>\n`);
    process.exit(1);
  }
}

const input = await Bun.stdin.text();

if (mode === "eval") {
  try {
    const { guard, event } = JSON.parse(input) as { guard: Guard; event: Event };
    process.stdout.write(`${JSON.stringify(new Runtime(disabledGuards()).evaluate([guard], event))}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: eval input could not be processed.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: provide a guard and event JSON object\n`);
    process.exit(1);
  }
}

if (mode === "hook") {
  let response;
  try {
    response = runPreToolUse(runtimeGuards(), JSON.parse(input), new Runtime(disabledGuards()));
  } catch (error) {
    response = { exitCode: 2 as const, stderr: `Guard runtime failed closed: ${error instanceof Error ? error.message : "unknown error"}` };
  }
  if (response.exitCode === 2 && process.argv[3] === "--agent=codex") {
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
  process.exit(response.exitCode);
}

process.stderr.write("WHAT failed: expected eval, hook, disable, doctor, init, install, scan, watch, or email.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
process.exit(1);
