import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approveLiveCompileProposal, authorizeHumanLiveCompileApproval, captureGitTreeSnapshot, reviewLiveCompileProposal } from "../../src/compiler/live-incident";
import { installGitShellShim } from "../../src/install/shell-shim";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  return Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
}

function waitFor(path: string): void {
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt += 1) Atomics.wait(cell, 0, 0, 20);
  expect(existsSync(path)).toBeTrue();
}

test("Shot 5: burn, detect, compile off-path, approve, then block the retry", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shot5-"));
  temporaryDirectories.push(root);
  const repository = join(root, "repo");
  const userHome = join(root, "user");
  const shimDirectory = join(root, "shim");
  const cliPath = join(import.meta.dir, "..", "..", "src", "cli.ts");
  const git = Bun.which("git");
  const shell = Bun.which("sh");
  expect(git).toBeTruthy();
  expect(shell).toBeTruthy();
  mkdirSync(repository);
  expect(run([git!, "init", "--quiet"], repository).exitCode).toBe(0);
  const launcher = join(repository, "launch.cmd");
  writeFileSync(launcher, "echo operational\n");
  expect(captureGitTreeSnapshot(repository, git!).untrackedPaths).toContain("launch.cmd");
  installGitShellShim({
    shimDirectory,
    runtimePath: join(import.meta.dir, "..", "..", "src", "hooks", "shell-shim-cli.ts"),
    gitExecutable: git!,
  });
  const shim = process.platform === "win32" ? join(shimDirectory, "git.cmd") : join(shimDirectory, "git");
  const environment = { ...process.env, USERPROFILE: userHome, HOME: userHome };
  const burn = process.platform === "win32"
    ? run([shim, "clean", "-fd"], repository, environment)
    : run([shell!, shim, "clean", "-fd"], repository, environment);
  expect(burn.exitCode).toBe(0);
  expect(existsSync(launcher)).toBeFalse();
  expect(burn.stderr.toString()).toContain("Live incident detected: 1 untracked operational file left the live tree");
  expect(burn.stderr.toString()).toContain("Background guard proposal scheduled; enforcement unchanged pending approval");
  const installedGuard = join(userHome, ".vibebloat", "guards", "live-git-clean-untracked.json");
  expect(existsSync(installedGuard)).toBeFalse();
  const proposal = join(userHome, ".vibebloat", "live-proposals", "live-git-clean-untracked", "live-git-clean-untracked.json");
  waitFor(proposal);
  const approval = run(["bun", cliPath, "approve-live", "live-git-clean-untracked"], repository, environment);
  expect(approval.exitCode).toBe(1);
  expect(approval.stderr.toString()).toContain("human TTY");
  const review = reviewLiveCompileProposal("live-git-clean-untracked", { scope: "machine", environment, cwd: repository });
  const humanApproval = authorizeHumanLiveCompileApproval("live-git-clean-untracked", review.guardSha256, {
    isTTY: true,
    env: {},
    parentProcess: "powershell",
  });
  expect(approveLiveCompileProposal(humanApproval, { scope: "machine", environment, cwd: repository })).toMatchObject({ status: "installed" });
  expect(existsSync(installedGuard)).toBeTrue();

  writeFileSync(launcher, "echo operational\n");
  const retry = process.platform === "win32"
    ? run([shim, "clean", "-fd"], repository, environment)
    : run([shell!, shim, "clean", "-fd"], repository, environment);

  expect(retry.exitCode).toBe(2);
  expect(retry.stderr.toString()).toContain("live incident");
  expect(existsSync(launcher)).toBeTrue();
  expect(captureGitTreeSnapshot(repository, git!).untrackedPaths).toContain("launch.cmd");
});
