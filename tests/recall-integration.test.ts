import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { globalGuardHome } from "../src/guard-home";
import { IncidentStore, defaultIncidentStorePath } from "../src/ingest/incidents-store";
import { buildSyncRecall } from "../src/ingest/recall-factory";

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
