import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("install requires explicit permission before creating agent configs", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync(["bun", "src/cli.ts", "install"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("FIX: vibebloat install --yes");
  expect(existsSync(join(directory, "claude", "settings.json"))).toBeFalse();
});

test("install creates Claude JSON and Codex TOML hooks after consent", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const claudeHome = join(directory, "claude"); const codexHome = join(directory, "codex");
  const result = Bun.spawnSync(["bun", "src/cli.ts", "install", "--yes"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toContain("vibebloat hook");
  const codex = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(codex).toContain("plugin_hooks = true");
  expect(codex).toContain("vibebloat hook --agent=codex");
});

test("fallback install requires explicit absolute shim and real git paths", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync(["bun", "src/cli.ts", "install", "--yes", "--fallback-shim-dir", join(directory, "shim")], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("requires both --fallback-shim-dir and --fallback-git");
  expect(existsSync(join(directory, "claude", "settings.json"))).toBeFalse();
});

test("explicit fallback installs both git shims without mutating parent PATH", () => {
  if (process.platform !== "win32") return;
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const shellDirectory = join(directory, "shells");
  const shimDirectory = join(directory, "shim");
  const posixShimDirectory = shimDirectory.replace(/^([A-Za-z]):[\\/](.*)$/, (_match, drive, path) => `/${drive.toLowerCase()}/${path.replaceAll("\\", "/")}`);
  const shellOutput: Record<string, string> = {
    bash: `${posixShimDirectory}:/usr/bin`,
    zsh: `${posixShimDirectory}:/usr/bin`,
    fish: `${posixShimDirectory}:/usr/bin`,
    pwsh: `${shimDirectory};C:/Windows`,
  };
  mkdirSync(shellDirectory, { recursive: true });
  for (const [shell, output] of Object.entries(shellOutput)) {
    writeFileSync(join(shellDirectory, `${shell}.cmd`), `@echo off\r\necho ${output}\r\n`);
  }
  const gitExecutable = Bun.which("git");
  expect(gitExecutable).toBeTruthy();
  const originalPath = process.env.PATH;
  const result = Bun.spawnSync(["bun", "src/cli.ts", "install", "--yes", "--fallback-shim-dir", shimDirectory, "--fallback-git", gitExecutable!], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PATH: `${shellDirectory};${originalPath}`, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(shimDirectory, "git"))).toBeTrue();
  expect(existsSync(join(shimDirectory, "git.cmd"))).toBeTrue();
  expect(process.env.PATH).toBe(originalPath);
});
