import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendFiring, readAndPruneFirings } from "../src/audit/firings";
import { installationState, runDoctor } from "../src/doctor/checks";
import { gitStashUntrackedGuard } from "../src/guards";
import { localSemanticIndexPath } from "../src/ingest/local-semantic";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("doctor reports missing proof and hook drift", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-"));
  tempDirectories.push(directory);
  writeFileSync(join(directory, "guard.json"), "{}");

  expect(runDoctor({ guardDirectory: directory, hookConfigs: { claude: "{}", codex: "plugin_hooks = true" } })).toEqual([
    { status: "error", check: "proof", message: "No runner-written proof marker found." },
    { status: "error", check: "claude-hook", message: "Claude Code hook is missing." },
    { status: "error", check: "codex-hook", message: "Codex hook is missing." },
  ]);
});

test("doctor CLI returns a three-line repair error when checks fail", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "installed.marker"), "partial install");
  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, HERMES_HOME: join(home, "hermes"), OPENCLAW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("WHAT failed: doctor found 3 problem(s).");
});

test("doctor reports missing chokepoints for explicit and empty bindings", () => {
  const options = {
    guardDirectories: [],
    guards: [
      { ...gitStashUntrackedGuard, id: "all-agents", binds: [] },
      { ...gitStashUntrackedGuard, id: "openclaw-only", binds: ["openclaw"] as const },
    ],
    installedAgents: ["claude-code", "codex", "hermes", "openclaw"] as const,
    hookConfigs: {
      claude: "vibebloat",
      codex: "plugin_hooks = true\nvibebloat",
      hermes: "",
      openclaw: "",
    },
  };

  expect(runDoctor(options)).toContainEqual({
    status: "error",
    check: "guard-bind",
    message: "Guards all-agents require hermes, but doctor could not verify its native chokepoint.",
  });
  expect(runDoctor(options)).toContainEqual({
    status: "error",
    check: "guard-bind",
    message: "Guards all-agents, openclaw-only require openclaw, but doctor could not verify its native chokepoint.",
  });
  expect(runDoctor({
    ...options,
    hookConfigs: { ...options.hookConfigs, openclaw: "plugin vibebloat registered" },
  }).some((finding) => finding.check === "guard-bind" && finding.message.includes("openclaw"))).toBeFalse();
});

test("doctor requires only the explicitly installed agent bindings", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-selected-"));
  tempDirectories.push(root);
  const guards = join(root, "guards");
  mkdirSync(guards, { recursive: true });
  writeFileSync(join(guards, "proof.json"), "{}\n");
  const options = {
    guardDirectories: [guards],
    installedAgents: ["hermes" as const],
    hookConfigs: { claude: "", codex: "", hermes: "vibebloat-hermes-pre-tool-call" },
  };
  expect(installationState(options)).toBe("installed");
  expect(runDoctor(options).filter(({ status }) => status === "error")).toEqual([]);
});

test("doctor distinguishes clean absence from partial installation residue", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-state-"));
  tempDirectories.push(root);
  const guardDirectory = join(root, "guards");
  const base = { guardDirectory, hookConfigs: { claude: "", codex: "" } };

  expect(installationState(base)).toBe("not-installed");
  mkdirSync(guardDirectory);
  writeFileSync(join(guardDirectory, "residue"), "partial");
  expect(installationState(base)).toBe("partial");
  rmSync(guardDirectory, { recursive: true });
  expect(installationState({ ...base, hookConfigs: { claude: "vibebloat", codex: "" } })).toBe("partial");
  const dataHome = join(root, "data-home");
  mkdirSync(join(dataHome, "audit"), { recursive: true });
  expect(installationState({ ...base, dataHomes: [dataHome] })).toBe("partial");
});

test("doctor CLI reports a clean uninstall as not installed", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-absent-"));
  tempDirectories.push(root);
  const environment = {
    ...process.env,
    USERPROFILE: join(root, "user"),
    HOME: join(root, "user"),
    VIBEBLOAT_HOME: join(root, "missing-vibebloat-home"),
    CLAUDE_CONFIG_DIR: join(root, "missing-claude"),
    CODEX_HOME: join(root, "missing-codex"),
    HERMES_HOME: join(root, "missing-hermes"),
    OPENCLAW_SESSION: "",
  };
  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("VibeBloat doctor: not installed.\n");
  expect(result.stderr.toString()).toBe("");

  mkdirSync(join(environment.USERPROFILE, ".vibebloat", "audit"), { recursive: true });
  const residue = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(residue.exitCode).toBe(1);
  expect(residue.stderr.toString()).toContain("WHAT failed: doctor found 3 problem(s).\n");
}, 30_000);

test("doctor uses the latest firing and supplied upstream versions for staleness warnings", () => {
  const findings = runDoctor({
    guards: [
      gitStashUntrackedGuard,
      { ...gitStashUntrackedGuard, id: "never-fired" },
      { ...gitStashUntrackedGuard, id: "version-drift" },
    ],
    lastFiredAtByGuard: {
      "git-stash-u": "2026-07-17T00:00:00.000Z",
      "version-drift": "2026-07-17T00:00:00.000Z",
    },
    installedAtByGuard: {
      "git-stash-u": "2026-01-01T00:00:00.000Z",
      "never-fired": "2026-04-19T00:00:00.000Z",
      "version-drift": "2026-07-17T00:00:00.000Z",
    },
    upstreamVersions: { "version-drift": { installed: "1.0.0", current: "2.0.0" } },
    now: new Date("2026-07-18T00:00:00.000Z"),
    hookConfigs: { claude: "vibebloat", codex: "plugin_hooks = true\nvibebloat" },
  });

  expect(findings.filter((finding) => finding.check === "guard-staleness")).toEqual([
    { status: "warning", check: "guard-staleness", message: "Guard never-fired needs reaffirmation: no-fire-in-90-days." },
    { status: "warning", check: "guard-staleness", message: "Guard version-drift needs reaffirmation: upstream-version-drift." },
  ]);
});

test("doctor verifies a receipt-selected custom Codex binding", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-custom-codex-"));
  tempDirectories.push(root);
  const repository = join(root, "repo");
  const home = join(root, "home");
  const customCodex = join(root, "custom-codex");
  mkdirSync(join(repository, ".vibebloat", "receipts"), { recursive: true });
  mkdirSync(join(home, "guards"), { recursive: true });
  mkdirSync(customCodex, { recursive: true });
  writeFileSync(join(home, "guards", "proof.json"), "{}\n");
  writeFileSync(join(customCodex, "config.toml"), "plugin_hooks = true\ncommand = 'vibebloat hook'\n");
  writeFileSync(join(home, "custom-agent-homes.json"), JSON.stringify({ schemaVersion: 1, owner: "vibebloat", homes: { codex: customCodex } }));
  writeFileSync(join(repository, ".vibebloat", "receipts", "onboarding-bindings.json"), JSON.stringify({
    schemaVersion: 1,
    owner: "vibebloat",
    kind: "onboarding-bindings",
    environments: [{ id: "codex", mechanism: "codex-pre-tool-use" }],
    gitBaseline: "verified",
    verifiedAt: new Date().toISOString(),
  }));
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "doctor"], {
    cwd: repository,
    env: { ...process.env, VIBEBLOAT_HOME: home, CODEX_HOME: join(root, "wrong-codex"), CLAUDE_CONFIG_DIR: join(root, "claude"), HERMES_HOME: join(root, "hermes") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("VibeBloat doctor: healthy.");
});

test("doctor reports exact guard conflicts, unreachable sources, and stale index", () => {
  const findings = runDoctor({
    guards: [
      gitStashUntrackedGuard,
      { ...gitStashUntrackedGuard, id: "warn-stash", action: { ...gitStashUntrackedGuard.action, type: "warn" } },
    ],
    sources: [{ id: "claude-code", reachable: true }, { id: "hermes", reachable: false }],
    semanticIndex: { configured: true, lastUpdatedAt: "2026-07-01T00:00:00.000Z" },
    now: new Date("2026-07-18T00:00:00.000Z"),
    hookConfigs: { claude: "vibebloat", codex: "plugin_hooks = true\nvibebloat" },
  });

  expect(findings).toContainEqual({
    status: "error",
    check: "guard-conflict",
    message: "Guards git-stash-u and warn-stash match the same event with different actions.",
  });
  expect(findings).toContainEqual({ status: "error", check: "source-health", message: "History source hermes is unreachable." });
  expect(findings).toContainEqual({ status: "warning", check: "index-freshness", message: "Semantic index is missing or stale." });
});

test("doctor checks fallback PATH and persistent watcher only when evidence is supplied", () => {
  const findings = runDoctor({
    requireProof: false,
    fallbackPathHealthy: false,
    filesystemGuardHealth: "absent",
    hookConfigs: { claude: "vibebloat", codex: "plugin_hooks = true\nvibebloat" },
  });

  expect(findings).toContainEqual({
    status: "error",
    check: "fallback-path",
    message: "Fallback shim is not first on every supported shell PATH.",
  });
  expect(findings).toContainEqual({
    status: "error",
    check: "filesystem-guard",
    message: "Persistent filesystem guard is not running with its owned receipt.",
  });
  expect(findings.some((finding) => finding.check === "proof")).toBeFalse();
});

test("doctor CLI rechecks selected local sources without reading history", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-source-"));
  tempDirectories.push(root);
  const home = join(root, "home");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  for (const directory of [join(home, "guards"), claude, codex]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, "guards", "proof.json"), "{}\n");
  writeFileSync(join(claude, "settings.json"), "vibebloat");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat");
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ coordinator: { selectedSourceIds: ["hermes"] } }));

  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: join(root, "missing-hermes"), OPENCLAW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("WHY: History source hermes is unreachable.\n");
  expect(result.stderr.toString()).toContain("FIX: vibebloat init\n");
});

test("doctor CLI reports locally cached semantic index staleness", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-index-"));
  tempDirectories.push(root);
  const home = join(root, "home");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  for (const directory of [join(home, "guards"), claude, codex]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, "guards", "proof.json"), "{}\n");
  writeFileSync(join(claude, "settings.json"), "vibebloat");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat");
  const indexPath = localSemanticIndexPath(import.meta.dir + "/..", home);
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, "local-index");
  const old = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(indexPath, old, old);

  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: join(root, "missing-hermes"), OPENCLAW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Semantic index is missing or stale.");
  expect(result.stderr.toString()).toBe("");
});

test("fresh install stays healthy in an OpenClaw delegated session", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-"));
  tempDirectories.push(root);
  const user = join(root, "user");
  const guards = join(root, "guards");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const hermes = join(root, "hermes");
  mkdirSync(guards, { recursive: true });
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  mkdirSync(hermes, { recursive: true });
  writeFileSync(join(guards, "proof.json"), "{}");
  writeFileSync(join(claude, "settings.json"), "vibebloat");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat");
  writeFileSync(join(hermes, "shell-hooks-allowlist.json"), "{\"approvals\":[]}\n");

  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, USERPROFILE: user, HOME: user, VIBEBLOAT_HOME: root, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: hermes, OPENCLAW_SESSION: "session" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toContain("VibeBloat doctor: healthy.\n");
  expect(result.stdout.toString()).toContain("Controlled release: in-process scrubber is active");
});

test("doctor requires complete digest-bound Hermes hook evidence", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-hermes-"));
  tempDirectories.push(root);
  const home = join(root, "home");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  const hermes = join(root, "hermes");
  for (const directory of [join(home, "guards"), claude, codex, join(hermes, "hooks", "vibebloat")]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(home, "guards", "proof.json"), "{}\n");
  writeFileSync(join(claude, "settings.json"), "vibebloat");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat");
  writeFileSync(join(hermes, "hooks", "vibebloat", "handler.py"), "# owned handler residue\n");

  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: hermes, OPENCLAW_SESSION: "session" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("require hermes, but doctor could not verify its native chokepoint");
  expect(result.stderr.toString()).not.toContain("openclaw");

  rmSync(join(hermes, "hooks"), { recursive: true });
  writeFileSync(join(hermes, "config.yaml"), "# vibebloat-hermes-pre-tool-call\n--vibebloat-handler-sha=deadbeef\n");
  const configOnly = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: hermes, OPENCLAW_SESSION: "session" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(configOnly.exitCode).toBe(1);
  expect(configOnly.stderr.toString()).toContain("require hermes, but doctor could not verify its native chokepoint");
});

test("doctor CLI uses durable last-fired summary after detailed events are pruned", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-summary-"));
  tempDirectories.push(root);
  const user = join(root, "user");
  const auditHome = join(user, ".vibebloat");
  const guards = join(root, "guards");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  for (const directory of [guards, claude, codex]) mkdirSync(directory, { recursive: true });
  const proof = join(guards, "proof.json");
  writeFileSync(proof, "{}");
  const now = new Date();
  const oldInstall = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);
  utimesSync(proof, oldInstall, oldInstall);
  writeFileSync(join(claude, "settings.json"), "vibebloat");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat");
  const recentFiring = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);
  appendFiring(auditHome, true, { guardId: "git-stash-u", class: "A", chokepoint: "shell", actionType: "block", blocked: true }, recentFiring);
  appendFiring(auditHome, true, { guardId: "mcp-config-wrong-file", class: "B", chokepoint: "file", actionType: "block", blocked: true }, recentFiring);
  expect(readAndPruneFirings(auditHome, now).events).toEqual([]);

  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, USERPROFILE: user, HOME: user, VIBEBLOAT_HOME: root, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: join(root, "missing-hermes"), OPENCLAW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("doctor found");
  expect(result.stdout.toString()).toContain("needs reaffirmation");
  expect(result.stderr.toString()).toBe("");
});
