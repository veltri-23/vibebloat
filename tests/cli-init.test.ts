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

test("init renders exact first gate and persists each explicit answer", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-init-"));
  temporaryDirectories.push(home);
  expect(JSON.parse(init(home).stdout.toString())).toMatchObject({ gate: "A0", prompt: { question: expect.stringContaining("VibeBloat") } });
  expect(JSON.parse(init(home, "--answer", "Yes").stdout.toString())).toMatchObject({ gate: "A1" });
  expect(JSON.parse(init(home, "--answer", "Just this project").stdout.toString())).toMatchObject({ gate: "F0" });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ gate: "F0", answers: { A0: "Yes", A1: "Just this project" } });
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
