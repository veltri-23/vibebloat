import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invoke(repository: string, environment: Record<string, string>, answer: string) {
  return Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "init", "--human", "--answer", answer], {
    cwd: repository,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("production onboarding coordinates discovery and fails closed before history or model reads", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-coordinator-"));
  roots.push(root);
  const repository = join(root, "repo");
  const home = join(root, "state");
  const hermesSession = join(root, ".hermes", "profiles", "default", "sessions", "failed.json");
  const modelMarker = join(root, "model-ran");
  mkdirSync(repository, { recursive: true });
  mkdirSync(join(hermesSession, ".."), { recursive: true });
  writeFileSync(hermesSession, "Authorization: Bearer raw-provider-token");
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);

  const environment = {
    USERPROFILE: root,
    HOME: root,
    VIBEBLOAT_HOME: home,
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CODEX_HOME: join(root, ".codex"),
    HERMES_HOME: join(root, ".hermes"),
    VIBEBLOAT_MODEL_COMMAND: JSON.stringify(["bun", "-e", `Bun.write(${JSON.stringify(modelMarker)}, "ran")`]),
  };
  const answers = [
    "Yes",
    "Just this project",
    "Yes",
    "That's everything",
    "Use these",
    "Not now",
    "Yes, but sharing off",
    "No thanks",
    "Run it locally and free (a bit slower)",
    "Stay quiet unless sure (recommended)",
    "Skip style rules",
  ];
  for (const answer of answers) {
    const result = invoke(repository, environment, answer);
    expect(result.exitCode).toBe(0);
  }

  const beforeScan = JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"));
  expect(beforeScan).toMatchObject({ gate: "F6", coordinator: { phase: "ready-to-scan", consented: true } });
  expect(beforeScan.coordinator.discovery.sources).toEqual([
    expect.objectContaining({ id: "hermes", environmentId: "hermes", label: "Hermes history" }),
  ]);

  const scan = invoke(repository, environment, "Skip");
  expect(scan.exitCode).toBe(1);
  expect(scan.stderr.toString()).toBe(
    "WHAT failed: onboarding scan blocked before history read.\n" +
    "WHY: Verified package-controlled scrubber assets are unavailable.\n" +
    "FIX: install a signed VibeBloat release, then rerun vibebloat init\n",
  );
  expect(existsSync(modelMarker)).toBeFalse();
  expect(existsSync(join(home, "failed-ingest"))).toBeFalse();
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({
    gate: "SCAN",
    coordinator: { phase: "paused", incidentCount: 0, installedGuardIds: [] },
  });
});
