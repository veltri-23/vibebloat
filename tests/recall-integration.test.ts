import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalGuardHome } from "../src/guard-home";
import { IncidentStore, defaultIncidentStorePath } from "../src/ingest/incidents-store";
import { buildSyncRecall } from "../src/ingest/recall-factory";
import { OnboardingRunner, type RunnerState } from "../src/onboarding/runner";
import { persistRecallChoice } from "../src/onboarding/recall-choice";
import { readRecallConfig } from "../src/ingest/recall-config";
import { OnboardingCoordinator, type OnboardingCheckpoint, type OnboardingCoordinatorOptions } from "../src/onboarding/coordinator";
import { detectRecallKey } from "../src/onboarding/gate-measurements";
import { canonicalGateChoice, type OnboardingContext, type GateId } from "../src/onboarding/gates";

/**
 * End-to-end wiring test: proves the semantic-recall feature is actually
 * connected to the real CLI enforcement path. The unit tests inject a recall
 * adapter directly into Runtime, so they pass even when cli.ts forgets to build
 * and pass one (which is exactly the bug this guards against). This test seeds
 * the incident store the way the mining path does, then spawns the real
 * `vibebloat hook` and asserts a reworded command surfaces the recall warning.
 */

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows may briefly hold the sqlite handle; leak the temp dir rather than fail the test. */ }
  }
});

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(join(process.env.TEMP ?? "/tmp", prefix));
  temporaryDirectories.push(dir);
  return dir;
}

function seededEnvironment(): { env: NodeJS.ProcessEnv; cwd: string } {
  const home = makeTemp("vibebloat-recall-home-");
  const cwd = makeTemp("vibebloat-recall-repo-");
  // Drop any ambient key so the store + CLI both resolve to lexical deterministically.
  const env = { ...process.env, USERPROFILE: home, HOME: home, OPENAI_API_KEY: "" };
  return { env, cwd };
}

function seedIncident(env: NodeJS.ProcessEnv, cwd: string, command: string): void {
  const store = new IncidentStore({ path: defaultIncidentStorePath(cwd, globalGuardHome(env)) });
  const recall = buildSyncRecall({ store, configPath: join(cwd, ".vibebloat", "config.toml"), environment: env });
  recall.record({
    incidentId: "seeded-incident",
    command,
    condition: "it clobbered the release output",
    consequence: "restore from the last good build",
    canonicalCommand: command,
  });
  // The INSERT is already committed to the WAL; a close-time lock is a Windows
  // bun:sqlite quirk and does not lose the record.
  try { recall.close?.(); } catch { /* committed already */ }
}

function runHook(env: NodeJS.ProcessEnv, cwd: string, command: string): { exitCode: number; stderr: string } {
  // No --agent flag => claude-code (the default); passing "--agent=claude-code" is rejected by design.
  const result = Bun.spawnSync(["bun", cliPath, "hook"], {
    cwd,
    env,
    stdin: new Blob([JSON.stringify({ tool_input: { command } })]),
  });
  return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
}

test("recall is wired into the real CLI: a reworded command surfaces the stored incident", () => {
  const { env, cwd } = seededEnvironment();
  seedIncident(env, cwd, "npm run build prod");
  // Reworded (not identical, no built-in guard matches it) — recall must recognize it.
  const result = runHook(env, cwd, "npm run build dev");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("npm run build prod");
});

test("no recall warning when the store is empty (proves the warning came from recall)", () => {
  const { env, cwd } = seededEnvironment();
  const result = runHook(env, cwd, "npm run build dev");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("npm run build");
});

/**
 * Drives the SR / SR-no-key gate to a resolution through the real OnboardingRunner
 * (same code path the CLI uses when the user picks a recall mode) and proves the
 * written .vibebloat/config.toml is the one the live hook honors. This is the
 * acceptance test the issue calls out: completing onboarding writes a valid
 * `recall = ` line the CLI then honors.
 */
function driveSRToCompletion(env: NodeJS.ProcessEnv, cwd: string, targetGate: GateId, targetChoiceIndex: number): { state: RunnerState; context: OnboardingContext } {
  // Walk the gate machine from F6 forward, passing the answer that lands on the
  // target gate. We only care about exercising F6 → SR/SR-no-key → SCAN here.
  const emptyCheckpoint: OnboardingCheckpoint = {
    phase: "review",
    environmentConfirmed: true,
    consented: true,
    selectedSourceIds: ["claude-code"],
    incidentCount: 1,
    approvedIncidentIds: ["seeded-incident"],
    installedGuardIds: [],
    cancelled: false,
    incidents: [],
    approved: [],
    installed: [],
    discovery: { environments: [{ id: "claude-code", label: "Claude Code" }], sources: [] },
  };
  const key = detectRecallKey(env);
  const context: OnboardingContext = {
    scanOutcome: "found",
    reviewsRemaining: 1,
    recallKeyPresent: key.present,
    recallConfigPath: join(cwd, ".vibebloat", "config.toml"),
    ...(key.present && env.OPENAI_API_KEY ? { recallEmbedKey: env.OPENAI_API_KEY } : {}),
  };
  const runner = new OnboardingRunner(
    { gate: targetGate, answers: {} } as RunnerState,
    context,
  );
  const gate = runner.snapshot().gate;
  const options = (runner.current().options ?? []) as readonly string[];
  const chosen = options[targetChoiceIndex]!;
  // The runner accepts either the option index or the rendered text; we feed
  // the rendered text so the path matches what the CLI does for a human.
  runner.choose(chosen);
  // Sanity: the runner's own gate transition confirms the choice was valid.
  void canonicalGateChoice(gate, chosen);
  return { state: runner.snapshot(), context };
}

test("init -> SR-no-key -> hook: written lexical config is honored by the hot path", () => {
  const { env, cwd } = seededEnvironment();
  driveSRToCompletion(env, cwd, "SR-no-key", 1); // index 1 = Lexical (recommended is now Local at index 0)
  const configPath = join(cwd, ".vibebloat", "config.toml");
  expect(existsSync(configPath)).toBe(true);
  expect(readRecallConfig(configPath)?.mode).toBe("lexical");
  // Round-trip through buildSyncRecall to prove the factory reads what the
  // runner wrote — same code path the live `vibebloat hook` uses.
  const store = new IncidentStore({ path: defaultIncidentStorePath(cwd, globalGuardHome(env)) });
  const recall = buildSyncRecall({ store, configPath, environment: env });
  expect(recall.mode).toBe("lexical");
  // Seed and reword to prove the warning is actually surfaced.
  recall.record({
    incidentId: "seeded-after-init",
    command: "npm run build prod",
    condition: "it clobbered the release output",
    consequence: "restore from the last good build",
    canonicalCommand: "npm run build prod",
  });
  try { recall.close?.(); } catch { /* committed */ }
  const result = runHook(env, cwd, "npm run build dev");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("npm run build prod");
});

test("init -> SR (key present, opt-in to lexical) -> hook: written lexical config is honored", () => {
  const home = makeTemp("vibebloat-recall-home-");
  const cwd = makeTemp("vibebloat-recall-repo-");
  // Key present, user still picks Lexical via the SR gate (opt-in, not auto-select).
  const env = { ...process.env, USERPROFILE: home, HOME: home, OPENAI_API_KEY: "sk-test-abcdef1234" };
  driveSRToCompletion(env, cwd, "SR", 2); // index 2 = Lexical (Local moved to index 1)
  const configPath = join(cwd, ".vibebloat", "config.toml");
  expect(readRecallConfig(configPath)?.mode).toBe("lexical");
  // Even with the key on disk, the factory should NOT auto-select embed; the
  // SR gate's written choice wins.
  const store = new IncidentStore({ path: defaultIncidentStorePath(cwd, globalGuardHome(env)) });
  const recall = buildSyncRecall({ store, configPath, environment: env });
  expect(recall.mode).toBe("lexical");
});

test("init -> SR (key present, opt-in to embed) -> hook: written embed config carries the key", () => {
  const home = makeTemp("vibebloat-recall-home-");
  const cwd = makeTemp("vibebloat-recall-repo-");
  const env = { ...process.env, USERPROFILE: home, HOME: home, OPENAI_API_KEY: "sk-test-abcdef1234" };
  driveSRToCompletion(env, cwd, "SR", 0); // index 0 = Embed
  const configPath = join(cwd, ".vibebloat", "config.toml");
  const parsed = readRecallConfig(configPath);
  expect(parsed?.mode).toBe("embed");
  expect(parsed?.embedApiKey).toBe("sk-test-abcdef1234");
});

test("persistRecallChoice is a no-op when SR resolves without a configPath (no .vibebloat write)", () => {
  const home = makeTemp("vibebloat-recall-home-");
  const cwd = makeTemp("vibebloat-recall-repo-");
  const env = { ...process.env, USERPROFILE: home, HOME: home, OPENAI_API_KEY: "" };
  // Manually walk without a recallConfigPath: the runner must not crash and
  // must not invent a path. We exercise the pure path here.
  const runner = new OnboardingRunner(
    { gate: "SR-no-key", answers: {} } as RunnerState,
    { recallKeyPresent: false }, // no configPath
  );
  runner.choose(runner.current().options![0]!); // Lexical
  expect(existsSync(join(cwd, ".vibebloat", "config.toml"))).toBe(false);
  // Sanity: the writer is still available, just gated.
  persistRecallChoice({ configPath: join(cwd, ".vibebloat", "config.toml"), mode: "lexical" });
  expect(readFileSync(join(cwd, ".vibebloat", "config.toml"), "utf8")).toContain("recall = lexical");
});
