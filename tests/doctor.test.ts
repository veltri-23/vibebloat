import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendFiring, readAndPruneFirings } from "../src/audit/firings";
import { installationState, runDoctor } from "../src/doctor/checks";
import { gitStashUntrackedGuard } from "../src/guards";

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

test("fresh install does not immediately warn stale", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-"));
  tempDirectories.push(root);
  const user = join(root, "user");
  const guards = join(root, "guards");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  mkdirSync(guards, { recursive: true });
  mkdirSync(claude, { recursive: true });
  mkdirSync(codex, { recursive: true });
  writeFileSync(join(guards, "proof.json"), "{}");
  writeFileSync(join(claude, "settings.json"), "vibebloat");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat");

  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, USERPROFILE: user, HOME: user, VIBEBLOAT_HOME: root, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, HERMES_HOME: join(root, "missing-hermes"), OPENCLAW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  expect(result.stdout.toString()).toBe("VibeBloat doctor: healthy.\n");
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
  expect(result.stdout.toString()).toBe("VibeBloat doctor: healthy.\n");
  expect(result.stderr.toString()).toBe("");
});
