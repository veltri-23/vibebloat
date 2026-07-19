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
    VIBEBLOAT_LOCAL_MODEL_COMMAND: JSON.stringify(["bun", "-e", `require('node:fs').writeFileSync(${JSON.stringify(modelMarker)}, "ran")`]),
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
    "WHAT failed: onboarding setup stopped.\n" +
    "WHY: Confirmed history could not be parsed.\n" +
    "FIX: vibebloat init --answer Yes\n",
  );
  expect(existsSync(join(home, "failed-ingest"))).toBeFalse();
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({
    gate: "F6",
    coordinator: { phase: "ready-to-scan", consented: true },
  });
});

test("production onboarding discovers installed agents without requiring history files", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-environments-"));
  roots.push(root);
  const repository = join(root, "repo");
  const home = join(root, "state");
  const claudeHome = join(root, ".claude");
  const codexHome = join(root, ".codex");
  const hermesHome = join(root, ".hermes");
  const openClawHome = join(root, ".openclaw");
  for (const directory of [repository, home, claudeHome, codexHome, hermesHome, openClawHome]) mkdirSync(directory, { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", scope: "repo", answers: {} }));

  const result = invoke(repository, {
    USERPROFILE: root,
    HOME: root,
    VIBEBLOAT_HOME: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    HERMES_HOME: hermesHome,
    OPENCLAW_HOME: openClawHome,
  }, "Yes");

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({
    gate: "B1",
    coordinator: {
      discovery: {
        environments: [
          { id: "claude-code", label: "Claude Code" },
          { id: "codex", label: "Codex" },
          { id: "hermes", label: "Hermes" },
          { id: "openclaw", label: "OpenClaw" },
        ],
        sources: [],
      },
    },
  });
});
