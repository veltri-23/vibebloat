import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disableGuard, disabledGuardIds } from "./cli/disable";
import { runDoctor } from "./doctor/checks";
import { loadGuards } from "./guard-loader";
import { forgetEmail } from "./growth/email-capture";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "./guards";
import { runPreToolUse } from "./hooks";
import { closeWatcherOnSignals, watchGuardedWrites } from "./install/fs-guard";
import { installNativeHooks } from "./install/orchestrator";
import { installHermesHook } from "./install/hermes";
import { isGateChoice } from "./onboarding/gates";
import { OnboardingRunner, type RunnerState } from "./onboarding/runner";
import { loadOnboardingState, saveOnboardingState } from "./onboarding/state";
import { Runtime } from "./runtime";
import type { Event, Guard } from "./types";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];
const mode = process.argv[2];

function homeDirectory(): string {
  return process.env.VIBEBLOAT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".vibebloat");
}

function runtimeGuards(): Guard[] {
  const installed = loadGuards(join(homeDirectory(), "guards"));
  const builtInIds = new Set(guards.map((guard) => guard.id));
  const duplicate = installed.find((guard) => builtInIds.has(guard.id));
  if (duplicate) throw new Error(`Installed guard duplicates built-in id: ${duplicate.id}`);
  return [...guards, ...installed];
}

function configText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

if (mode === "doctor") {
  const home = homeDirectory();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex");
  const findings = runDoctor({
    guardDirectory: join(home, "guards"),
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
  forgetEmail(homeDirectory());
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
    installNativeHooks({
      permitted: true,
      claudePath: join(claudeHome, "settings.json"),
      codexPath: join(codexHome, "config.toml"),
      command: "vibebloat hook",
    });
    if (hermesHooksDirectory) installHermesHook({ permitted: true, hooksDirectory: hermesHooksDirectory });
    process.stdout.write("Native hooks installed. Run: vibebloat doctor\n");
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: native hook installation stopped.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat install --yes\n`);
    process.exit(1);
  }
}

if (mode === "init") {
  const home = homeDirectory();
  const stored = loadOnboardingState(home);
  const state: RunnerState = stored
    ? { gate: stored.gate as RunnerState["gate"], answers: stored.answers, cancelled: stored.cancelled }
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
    disableGuard(process.argv[3] ?? "");
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
        process.stderr.write(`WHAT blocked: guarded write at ${path}.\nWHY: ${response.stderr ?? "filesystem guard denied write."}\nFIX: change write or disable guard.\n`);
      }, new Runtime(disabledGuardIds()));
      closeWatcherOnSignals(watcher, process, resolve);
      process.stdout.write(`Watching guarded writes in ${directory}. Press Ctrl+C to stop.\n`);
    });
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: filesystem watch could not start.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat watch <directory>\n`);
    process.exit(1);
  }
}

const input = await Bun.stdin.text();

if (mode === "eval") {
  try {
    const { guard, event } = JSON.parse(input) as { guard: Guard; event: Event };
    process.stdout.write(`${JSON.stringify(new Runtime(disabledGuardIds()).evaluate([guard], event))}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: eval input could not be processed.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: provide a guard and event JSON object\n`);
    process.exit(1);
  }
}

if (mode === "hook") {
  let response;
  try {
    response = runPreToolUse(runtimeGuards(), JSON.parse(input), new Runtime(disabledGuardIds()));
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

process.stderr.write("WHAT failed: expected eval, hook, disable, doctor, init, install, watch, or email.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
process.exit(1);
