import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempDirectories: string[] = [];
const projectRoot = join(import.meta.dir, "..");
const cliPath = join(projectRoot, "src", "cli.ts");
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function repository(directory: string): string {
  const path = join(directory, "repo");
  mkdirSync(path);
  const result = Bun.spawnSync(["git", "init", "-q"], { cwd: path });
  expect(result.exitCode).toBe(0);
  return path;
}

test("install requires explicit permission before creating agent configs", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync(["bun", cliPath, "install"], {
    cwd: repository(directory),
    env: { ...process.env, VIBEBLOAT_HOME: join(directory, "home"), CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
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
  const repo = repository(directory);
  const claudeHome = join(directory, "claude"); const codexHome = join(directory, "codex");
  const environment = { ...process.env, VIBEBLOAT_HOME: join(directory, "home"), CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  const result = Bun.spawnSync(["bun", cliPath, "install", "--yes"], {
    cwd: repo,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toContain("vibebloat hook");
  const codex = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(codex).toContain("plugin_hooks = true");
  expect(codex).toContain("vibebloat hook --agent=codex");
  const preCommit = join(repo, ".git", "hooks", "pre-commit");
  const prePush = join(repo, ".git", "hooks", "pre-push");
  expect(readFileSync(preCommit, "utf8")).toContain("vibebloat git-hook pre-commit");
  expect(readFileSync(prePush, "utf8")).toContain("vibebloat git-hook pre-push");
  if (process.platform !== "win32") expect(statSync(preCommit).mode & 0o111).not.toBe(0);
  expect(existsSync(join(repo, ".vibebloat", "receipts", "fs-guard.json"))).toBeFalse();

  const toolDirectory = join(directory, "bin");
  mkdirSync(toolDirectory);
  const bun = Bun.which("bun")!.replaceAll("\\", "/");
  const toolPath = join(toolDirectory, "vibebloat");
  writeFileSync(toolPath, `#!/bin/sh\nexec "${bun}" "${cliPath.replaceAll("\\", "/")}" "$@"\n`, { mode: 0o755 });
  const hook = Bun.spawnSync([Bun.which("git")!, "hook", "run", "pre-commit"], {
    cwd: repo, env: { ...environment, PATH: `${toolDirectory}${process.platform === "win32" ? ";" : ":"}${environment.PATH}` }, stdout: "pipe", stderr: "pipe",
  });
  expect(hook.exitCode).toBe(0);
  expect(hook.stderr.toString()).toBe("");
});

test("fallback install requires explicit absolute shim and real git paths", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync(["bun", cliPath, "install", "--yes", "--fallback-shim-dir", join(directory, "shim")], {
    cwd: repository(directory),
    env: { ...process.env, VIBEBLOAT_HOME: join(directory, "home"), CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
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
  const result = Bun.spawnSync(["bun", cliPath, "install", "--yes", "--fallback-shim-dir", shimDirectory, "--fallback-git", gitExecutable!], {
    cwd: repository(directory),
    env: { ...process.env, PATH: `${shellDirectory};${originalPath}`, VIBEBLOAT_HOME: join(directory, "home"), CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(existsSync(join(shimDirectory, "git"))).toBeTrue();
  expect(existsSync(join(shimDirectory, "git.cmd"))).toBeTrue();
  expect(process.env.PATH).toBe(originalPath);
}, 30_000);

test("git-hook mode blocks only a matching synthetic Git event without stdin", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-git-hook-"));
  tempDirectories.push(directory);
  const repo = repository(directory);
  const home = join(directory, "home");
  mkdirSync(join(home, "guards"), { recursive: true });
  writeFileSync(join(home, "guards", "block-commit.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "block-commit",
    class: "A",
    provenance: { incident: "test", date: "2026-07-18", source: "local" },
    match: { chokepoint: "shell", command: "git commit" },
    action: { type: "block", message: "Commit blocked.", override: "vibebloat allow block-commit --once" },
    enabled: true,
  })}\n`);
  const environment = { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: directory, HOME: directory };

  const blocked = Bun.spawnSync(["bun", cliPath, "git-hook", "pre-commit"], { cwd: repo, env: environment, stdout: "pipe", stderr: "pipe" });
  const allowed = Bun.spawnSync(["bun", cliPath, "git-hook", "pre-push"], { cwd: repo, env: environment, stdout: "pipe", stderr: "pipe" });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr.toString()).toContain("Commit blocked.");
  expect(allowed.exitCode).toBe(0);
});

test("CLI uninstall removes integrations idempotently and preserves opted-in data", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-uninstall-"));
  tempDirectories.push(directory);
  const repo = repository(directory);
  const home = join(directory, "home");
  const environment = {
    ...process.env,
    VIBEBLOAT_HOME: home,
    USERPROFILE: directory,
    HOME: directory,
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    CODEX_HOME: join(directory, "codex"),
    HERMES_HOME: join(directory, "hermes"),
  };
  expect(Bun.spawnSync(["bun", cliPath, "install", "--yes"], { cwd: repo, env: environment }).exitCode).toBe(0);
  mkdirSync(join(home, "audit", "firings"), { recursive: true });
  writeFileSync(join(home, "audit", "firings", "event.json"), "{}");

  const refused = Bun.spawnSync(["bun", cliPath, "uninstall"], { cwd: repo, env: environment, stdout: "pipe", stderr: "pipe" });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toBe("WHAT failed: uninstall permission was not confirmed.\nWHY: uninstall changes native agent configuration and local data.\nFIX: vibebloat uninstall --yes\n");
  expect(readFileSync(join(environment.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")).toContain("vibebloat hook");

  const first = Bun.spawnSync(["bun", cliPath, "uninstall", "--yes", "--keep-data"], { cwd: repo, env: environment, stdout: "pipe", stderr: "pipe" });
  const second = Bun.spawnSync(["bun", cliPath, "uninstall", "--yes", "--keep-data"], { cwd: repo, env: environment, stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(readFileSync(join(environment.CLAUDE_CONFIG_DIR, "settings.json"), "utf8")).not.toContain("vibebloat hook");
  expect(readFileSync(join(environment.CODEX_HOME, "config.toml"), "utf8")).not.toContain("vibebloat hook --agent=codex");
  expect(readFileSync(join(repo, ".git", "hooks", "pre-commit"), "utf8")).not.toContain("vibebloat git-hook");
  expect(existsSync(join(home, "audit", "firings", "event.json"))).toBeTrue();
});
