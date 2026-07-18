import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function init(home: string, ...args: string[]) {
  return Bun.spawnSync(["bun", "src/cli.ts", "init", ...args], {
    cwd: import.meta.dir + "/..", env: { ...process.env, VIBEBLOAT_HOME: home }, stdout: "pipe", stderr: "pipe",
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
});

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
  expect(result.stderr.toString()).toBe("WHAT failed: expected allow, compile, eval, hook, disable, doctor, init, install, scan, watch, or email.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
});

test("F0 consent installs native hooks before advancing", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  const claudeHome = join(home, "claude"); const codexHome = join(home, "codex");
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F0", answers: {} }));
  const result = Bun.spawnSync(["bun", "src/cli.ts", "init", "--answer", "Yes"], {
    cwd: import.meta.dir + "/..", env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ gate: "B1" });
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toContain("vibebloat hook");
  expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("plugin_hooks = true");
});

test("init advances only silent gates after a valid human answer", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F2", answers: {} }));
  expect(JSON.parse(init(home, "--answer", "Run it locally and free (a bit slower)").stdout.toString())).toMatchObject({ gate: "F4" });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ gate: "F4", answers: { F2: "Run it locally and free (a bit slower)" } });
});

test("init never starts the scan from a silent transition", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "F6", answers: {} }));
  expect(JSON.parse(init(home, "--answer", "Skip").stdout.toString())).toMatchObject({ gate: "SCAN" });
});

test("init saves a Cancel from every gate without advancing", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "A1", answers: {} }));
  expect(JSON.parse(init(home, "--answer", "cancel").stdout.toString())).toMatchObject({ gate: "A1", cancelled: true });
});
