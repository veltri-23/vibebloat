import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installGitShellShim } from "../src/install/shell-shim";
import { shellPathProbe, verifyShellPaths } from "../src/install/shim";

const shimDirectory = "C:/tools/vibebloat";
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("PATH probe is defined for bash, zsh, fish, and pwsh", () => {
  for (const shell of ["bash", "zsh", "fish", "pwsh"] as const) {
    expect(shellPathProbe(shell, shimDirectory)).toContain(shell === "pwsh" ? shimDirectory : "/c/tools/vibebloat");
  }
});

test("install verification requires shim first in every configured shell", () => {
  verifyShellPaths(shimDirectory, (shell) => shell === "pwsh"
    ? `${shimDirectory};C:/Windows/System32`
    : `/c/tools/vibebloat:/usr/bin`);
});

test("install verification fails when a shell prepends another PATH entry", () => {
  expect(() => verifyShellPaths(shimDirectory, (shell) => shell === "fish"
    ? "/usr/local/bin:/c/tools/vibebloat"
    : shell === "pwsh"
      ? `${shimDirectory};C:/Windows/System32`
      : "/c/tools/vibebloat:/usr/bin")).toThrow("fish");
});

test("installer writes interceptable POSIX and Windows git shims", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shim-"));
  temporaryDirectories.push(directory);
  const posixShim = installGitShellShim({
    shimDirectory: directory,
    runtimePath: join(directory, "shell-shim-cli.ts"),
    gitExecutable: join(directory, "real-git.exe"),
  });
  expect(readFileSync(posixShim, "utf8")).toContain(`exec '${process.execPath.replaceAll("\\", "/")}'`);
  const windowsShim = readFileSync(join(directory, "git.cmd"), "utf8");
  expect(windowsShim).toContain(`"${process.execPath.replaceAll("\\", "/")}"`);
  expect(windowsShim).not.toContain("BUN_EXECUTABLE");
  expect(windowsShim).toContain("%*");
});

test("Windows git.cmd ignores hostile Bun environment and PATH before blocking destructive stash", () => {
  if (process.platform !== "win32") return;
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shim-"));
  temporaryDirectories.push(directory);
  const attackerDirectory = join(directory, "attacker");
  const marker = join(directory, "attacker-ran");
  mkdirSync(attackerDirectory);
  writeFileSync(join(attackerDirectory, "bun.cmd"), `@echo off\r\necho PATH > "${marker}"\r\n`);
  const gitExecutable = Bun.which("git");
  expect(gitExecutable).toBeTruthy();
  installGitShellShim({
    shimDirectory: directory,
    runtimePath: join(import.meta.dir, "..", "src", "hooks", "shell-shim-cli.ts"),
    gitExecutable: gitExecutable!,
  });
  const shimPath = join(directory, "git.cmd");
  const result = Bun.spawnSync([shimPath, "stash", "--all"], {
    cwd: directory,
    env: {
      ...process.env,
      BUN_EXECUTABLE: `C:\\missing.exe" & echo ENV > "${marker}" & rem`,
      PATH: `${attackerDirectory};${process.env.PATH ?? ""}`,
      VIBEBLOAT_HOME: join(directory, "home"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("07-15 this deleted untracked files");
  expect(existsSync(marker)).toBeFalse();
});

test("Windows git.cmd blocks a repo-scoped compiled shell guard", () => {
  if (process.platform !== "win32") return;
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shim-"));
  temporaryDirectories.push(directory);
  const shimDirectory = join(directory, "shim");
  const userHome = join(directory, "user");
  const guards = join(directory, ".vibebloat", "guards");
  mkdirSync(guards, { recursive: true });
  writeFileSync(join(guards, "no-git-status.json"), JSON.stringify({
    id: "no-git-status",
    class: "A",
    provenance: { incident: "test", date: "2026-07-18", source: "test" },
    match: { chokepoint: "shell", command: "git status" },
    action: { type: "block", message: "Repo guard blocked status.", override: "vibebloat allow no-git-status --once" },
    enabled: true,
  }));
  const gitExecutable = Bun.which("git");
  expect(gitExecutable).toBeTruthy();
  installGitShellShim({
    shimDirectory,
    runtimePath: join(import.meta.dir, "..", "src", "hooks", "shell-shim-cli.ts"),
    gitExecutable: gitExecutable!,
  });
  const { VIBEBLOAT_HOME: _ignored, ...environment } = process.env;
  const result = Bun.spawnSync([join(shimDirectory, "git.cmd"), "status"], {
    cwd: directory,
    env: { ...environment, USERPROFILE: userHome, HOME: userHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Repo guard blocked status.");
});
