import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
setDefaultTimeout(15_000);
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function init(home: string, ...args: string[]) {
  return Bun.spawnSync(["bun", "src/cli.ts", "init", ...args], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      VIBEBLOAT_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CODEX_HOME: join(home, "codex"),
      HERMES_HOME: join(home, "hermes"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function initAt(repository: string, home: string, overrides: Record<string, string>, ...args: string[]) {
  return Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "init", ...args], {
    cwd: repository,
    env: { ...process.env, VIBEBLOAT_HOME: home, ...overrides },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function invoke(home: string, ...args: string[]) {
  return Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    cwd: import.meta.dir + "/..", env: { ...process.env, VIBEBLOAT_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
}

test("init renders exact first gate and persists each explicit answer", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  expect(JSON.parse(init(home).stdout.toString())).toMatchObject({ gate: "A0", prompt: { question: expect.stringContaining("VibeBloat") } });
  expect(JSON.parse(init(home, "--answer", "Yes").stdout.toString())).toMatchObject({ gate: "A1" });
  expect(JSON.parse(init(home, "--answer", "Just this project").stdout.toString())).toMatchObject({ gate: "F0", scope: "repo" });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ gate: "F0", scope: "repo", answers: { A0: "Yes", A1: "Just this project" } });
  expect(JSON.parse(init(home, "--answer", "Yes").stdout.toString())).toMatchObject({ gate: "B1", scope: "repo" });
}, 30_000);

test("init does not mutate setup before F0 consent", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const claudeHome = join(home, "claude"); const codexHome = join(home, "codex");
  const result = Bun.spawnSync(["bun", "src/cli.ts", "init"], {
    cwd: import.meta.dir + "/..", env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(claudeHome, "settings.json"))).toBeFalse();
  expect(existsSync(join(codexHome, "config.toml"))).toBeFalse();
});

test("no mode opens the initial onboarding gate without setup mutation", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const claudeHome = join(home, "claude"); const codexHome = join(home, "codex");
  const result = Bun.spawnSync(["bun", "src/cli.ts"], {
    cwd: import.meta.dir + "/..", env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ gate: "A0", prompt: { question: expect.stringContaining("VibeBloat") } });
  expect(existsSync(join(home, "onboarding.json"))).toBeFalse();
  expect(existsSync(join(claudeHome, "settings.json"))).toBeFalse();
  expect(existsSync(join(codexHome, "config.toml"))).toBeFalse();
});

test("unknown mode keeps the three-line error", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const result = invoke(home, "unknown");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("WHAT failed: expected allow, compile, eval, hook, git-hook, disable, doctor, init, onboard, install, uninstall, update, scan, star, stats, sync, watch, daily, rules, or email, scrub, or __distribution_probe__.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
});

test("F0 consent preflights helpers but defers writes until selected binding install", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const repository = join(home, "repo");
  require("node:fs").mkdirSync(repository);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  const claudeHome = join(home, "claude"); const codexHome = join(home, "codex");
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", answers: {} }));
  const result = initAt(repository, home, { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }, "--answer", "Yes");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ gate: "B1" });
  expect(existsSync(join(claudeHome, "settings.json"))).toBeFalse();
  expect(existsSync(join(codexHome, "config.toml"))).toBeFalse();
  expect(existsSync(join(repository, ".git", "hooks", "pre-commit"))).toBeFalse();
  expect(existsSync(join(repository, ".git", "hooks", "pre-push"))).toBeFalse();
});

test("F0 does not create Git hooks before consent", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const repository = join(home, "repo");
  require("node:fs").mkdirSync(repository);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  const claudeHome = join(home, "claude"); const codexHome = join(home, "codex");
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", answers: {} }));

  const result = initAt(repository, home, { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(repository, ".git", "hooks", "pre-commit"))).toBeFalse();
  expect(existsSync(join(repository, ".git", "hooks", "pre-push"))).toBeFalse();
  expect(existsSync(join(claudeHome, "settings.json"))).toBeFalse();
  expect(existsSync(join(codexHome, "config.toml"))).toBeFalse();
});

test("F0 Git-hook preflight stops before native config mutation", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const repository = join(home, "repo");
  require("node:fs").mkdirSync(repository);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  writeFileSync(join(repository, ".git", "hooks", "pre-commit"), "# vibebloat:start\nhost code\n");
  const claudeHome = join(home, "claude"); const codexHome = join(home, "codex");
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", answers: {} }));

  const result = initAt(repository, home, { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }, "--answer", "Yes");

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("onboarding setup stopped");
  expect(existsSync(join(claudeHome, "settings.json"))).toBeFalse();
  expect(existsSync(join(codexHome, "config.toml"))).toBeFalse();
});

test("init advances only silent gates after a valid human answer", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F2", answers: {} }));
  const result = initAt(join(import.meta.dir, ".."), home, {
    VIBEBLOAT_LOCAL_MODEL_COMMAND: JSON.stringify(["ollama", "run", "local-model"]),
  }, "--answer", "Run it locally and free (a bit slower)");
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ gate: "F4" });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({
    gate: "F4",
    answers: { F2: "Run it locally and free (a bit slower)" },
    preferences: { modelRoute: "local" },
  });
});

test("init refuses a model route when no fallback is available", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F2", answers: {} }));
  const env: Record<string, string | undefined> = { ...process.env, VIBEBLOAT_HOME: home };
  env.VIBEBLOAT_MODEL_COMMAND = JSON.stringify(["bun", "-e", "process.exit(0)"]);
  delete env.VIBEBLOAT_LOCAL_MODEL_COMMAND;
  delete env.OPENAI_API_KEY;
  delete env.VIBEBLOAT_AGENT_MODEL_COMMAND;
  delete env.VIBEBLOAT_API_MODEL_COMMAND;
  const result = Bun.spawnSync(["bun", "src/cli.ts", "init", "--answer", "Use my own API key"], {
    cwd: import.meta.dir + "/..", env, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("OPENAI_API_KEY");
});

test("init falls back to built-in OpenAI command when OPENAI_API_KEY is set", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F2", answers: {} }));
  const env = { ...process.env, VIBEBLOAT_HOME: home, OPENAI_API_KEY: "sk-test" };
  delete env.VIBEBLOAT_MODEL_COMMAND;
  delete env.VIBEBLOAT_LOCAL_MODEL_COMMAND;
  delete env.VIBEBLOAT_AGENT_MODEL_COMMAND;
  delete env.VIBEBLOAT_API_MODEL_COMMAND;
  const result = Bun.spawnSync(["bun", "src/cli.ts", "init", "--answer", "Use my own API key"], {
    cwd: import.meta.dir + "/..", env, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).not.toBe(1);
});

test("init never starts the scan from a silent transition", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F6", answers: {} }));
  expect(JSON.parse(init(home, "--answer", "Skip").stdout.toString())).toMatchObject({ gate: "SCAN" });
}, 15_000);

test("init saves a Cancel from every gate without advancing", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "A1", answers: {} }));
  expect(JSON.parse(init(home, "--answer", "cancel").stdout.toString())).toMatchObject({ gate: "A1", cancelled: true });
});

test("init answers freeform help without advancing or mutating setup", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "A1", answers: {} }));
  const result = init(home, "--answer", "what does this change?");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    gate: "A1",
    prompt: { question: expect.any(String), options: expect.any(Array) },
    assist: { answer: expect.any(String) },
  });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ gate: "A1", answers: {} });
});

test("init can recommend and apply without skipping the gate", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "A1", answers: {} }));
  const result = init(home, "--answer", "recommend and apply");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    gate: "F0",
    scope: "machine",
    assist: { appliedOption: expect.any(String) },
  });
});

test("empty-history starter choice installs the preventive pack before advancing", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "G-empty", scope: "repo", answers: {} }));
  const result = init(home, "--answer", "Yes");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ gate: "N1" });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ preferences: { starterPack: true } });
  for (const id of ["starter-git-stash-untracked", "starter-rm-recursive-force", "starter-git-force-push", "starter-git-reset-hard"]) {
    expect(existsSync(join(home, "guards", `${id}.json`))).toBeTrue();
  }
});

test("starter pack collision keeps onboarding on its current gate", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  require("node:fs").mkdirSync(join(home, "guards"), { recursive: true });
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "I-zero", scope: "repo", answers: {} }));
  writeFileSync(join(home, "guards", "starter-rm-recursive-force.json"), "local collision\n");
  const result = init(home, "--answer", "Yes");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Starter guard conflicts with existing local guard");
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ gate: "I-zero" });
  expect(existsSync(join(home, "guards", "starter-git-stash-untracked.json"))).toBeFalse();
});

test("B1 missing rescans supplied history directories without exposing paths in onboarding state", { timeout: 15_000 }, () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const repository = join(home, "repo");
  const cursorHome = join(home, "cursor-home");
  const customCodexHome = join(home, "custom-codex");
  require("node:fs").mkdirSync(repository);
  require("node:fs").mkdirSync(cursorHome);
  require("node:fs").mkdirSync(customCodexHome);
  writeFileSync(join(cursorHome, "history.jsonl"), '{"session_id":"cursor-custom","message":{"role":"user","content":"one"}}\n');
  writeFileSync(join(customCodexHome, "history.jsonl"), '{"session_id":"custom","message":{"role":"user","content":"one"}}\n');
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", scope: "repo", answers: {} }));
  const environment = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), HERMES_HOME: join(home, "hermes") };
  expect(initAt(repository, home, environment, "--answer", "Yes").exitCode).toBe(0);
  expect(initAt(repository, home, environment, "--answer", "You missed one").exitCode).toBe(0);
  expect(initAt(repository, home, environment, "--answer", `Cursor at ${cursorHome}`).exitCode).toBe(0);
  let stored = JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"));
  expect(stored.coordinator.discovery.environments).toContainEqual({ id: "codex", label: "Cursor" });
  expect(stored.coordinator.discovery.sources).toContainEqual(expect.objectContaining({ id: "codex", environmentId: "codex", label: "Codex history" }));
  expect(JSON.stringify(stored)).not.toContain(cursorHome);
  expect(JSON.parse(readFileSync(join(home, "custom-agent-homes.json"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    owner: "vibebloat",
    homes: { codex: cursorHome },
  });
  expect(initAt(repository, home, environment, "--answer", "Ignore some of these").exitCode).toBe(0);
  expect(initAt(repository, home, environment, "--answer", "Cursor").exitCode).toBe(0);
  stored = JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"));
  expect(stored.coordinator.discovery.environments).not.toContainEqual({ id: "codex", label: "Cursor" });
  expect(JSON.parse(readFileSync(join(home, "custom-agent-homes.json"), "utf8"))).toMatchObject({ homes: {} });

  expect(initAt(repository, home, environment, "--answer", "You missed one").exitCode).toBe(0);
  expect(initAt(repository, home, environment, "--answer", `Codex at ${customCodexHome}`).exitCode).toBe(0);
  stored = JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"));
  expect(stored.coordinator.discovery.sources).toContainEqual(expect.objectContaining({ id: "codex", environmentId: "codex", label: "Codex history" }));
  expect(JSON.stringify(stored)).not.toContain(customCodexHome);
  expect(JSON.parse(readFileSync(join(home, "custom-agent-homes.json"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    owner: "vibebloat",
    homes: { codex: customCodexHome },
  });
});

test("B1 missing rejects unbounded custom directory input before it can be rescanned", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const repository = join(home, "repo");
  require("node:fs").mkdirSync(repository);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", scope: "repo", answers: {} }));
  const environment = { CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), HERMES_HOME: join(home, "hermes") };
  expect(initAt(repository, home, environment, "--answer", "Yes").exitCode).toBe(0);
  expect(initAt(repository, home, environment, "--answer", "You missed one").exitCode).toBe(0);
  const result = initAt(repository, home, environment, "--answer", `Codex at ${"x".repeat(4_097)}`);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("Missing environment path must be an existing absolute directory.");
  const stored = JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"));
  expect(stored.gate).toBe("B1.missing");
  expect(JSON.stringify(stored)).not.toContain("x".repeat(128));
});

test("unverified onboarding effects fail closed without advancing", () => {
  const cases = [
    ["F6", "Yes", "Skip"],
    ["N2", "Yes, notify me (uses your email)", "Skip"],
    ["O1", "Yes", "Manual only"],
    ["O2", "Yes", "No"],
    ["O3", "Auto-update with rollback", "Just let me know (recommended)"],
  ] as const;
  for (const [gate, answer, fallback] of cases) {
    const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
    temporaryDirectories.push(home);
    writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate, scope: "repo", answers: {} }));
    const result = init(home, "--answer", answer);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("WHAT failed: onboarding effect was not activated.");
    expect(result.stderr.toString()).toContain(gate === "O1"
      ? "FIX: install a signed VibeBloat release, then rerun vibebloat init"
      : `FIX: vibebloat init --answer ${JSON.stringify(fallback)}`);
    expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ gate });
  }
});

test("manual steady-state choices can finish without fake effect receipts", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "O3", scope: "repo", answers: {} }));
  const result = init(home, "--answer", "Just let me know (recommended)");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ gate: "END" });
});

test("D1 adjustment persists only validated discovered source ids", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const checkpoint = {
    phase: "triage", scope: "repo", environmentConfirmed: true, consented: false,
    selectedSourceIds: [], incidentCount: 0, approvedIncidentIds: [], installedGuardIds: [], cancelled: false,
    scanRunId: "00000000-0000-4000-8000-000000000001",
    discovery: {
      environments: [{ id: "claude-code", label: "Claude Code" }, { id: "codex", label: "Codex" }],
      sources: [
        { id: "claude-code", environmentId: "claude-code", label: "Claude history", lastActive: "2026-07-17T00:00:00.000Z", stale: false },
        { id: "codex", environmentId: "codex", label: "Codex history", lastActive: "2026-07-17T00:00:00.000Z", stale: false },
      ],
    },
    incidents: [], approved: [], installed: [],
  };
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "D1", scope: "repo", answers: {}, coordinator: checkpoint }));
  const adjusted = init(home, "--answer", "Let me adjust", "--sources=codex");
  expect(adjusted.exitCode).toBe(0);
  expect(JSON.parse(adjusted.stdout.toString())).toMatchObject({ gate: "D1", pendingSourceIds: ["codex"] });
  const applied = init(home, "--answer", "Use these");
  expect(applied.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({
    coordinator: { selectedSourceIds: ["codex"] },
  });
});
