import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  expect(readFileSync(posixShim, "utf8")).toContain('exec "${BUN_EXECUTABLE:-bun}"');
  const windowsShim = readFileSync(join(directory, "git.cmd"), "utf8");
  expect(windowsShim).toContain('"%BUN_EXECUTABLE%"');
  expect(windowsShim).toContain("%*");
});

test("Windows git.cmd routes destructive stash through the fail-closed shim", () => {
  if (process.platform !== "win32") return;
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shim-"));
  temporaryDirectories.push(directory);
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
    env: { ...process.env, BUN_EXECUTABLE: process.execPath, VIBEBLOAT_HOME: join(directory, "home") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("07-15 this deleted untracked files");
});
