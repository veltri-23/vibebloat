import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installNativeHooks } from "../../src/install/orchestrator";

const temporaryDirectories: string[] = [];
const projectRoot = join(import.meta.dir, "../..");
const cliPath = join(projectRoot, "src/cli.ts");

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function run(command: string[], cwd: string, env: Record<string, string | undefined> = process.env) {
  return Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
}

test("Shot 5: incident compiles into an installed guard that blocks the retry", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-shot5-"));
  temporaryDirectories.push(directory);
  const repository = join(directory, "repo");
  const home = join(directory, "home");
  const shimDirectory = join(directory, "shim");
  const posixShimDirectory = shimDirectory.replace(/^([A-Za-z]):[\\/](.*)$/, (_match, drive, path) => `/${drive.toLowerCase()}/${path.replaceAll("\\", "/")}`);
  const gitExecutable = Bun.which("git");
  const shell = Bun.which("sh");
  expect(gitExecutable).toBeTruthy();
  expect(shell).toBeTruthy();
  const git = gitExecutable!;
  const sh = shell!;

  run([git, "init", "--quiet", repository], directory);
  const launcher = join(repository, "launch.cmd");
  writeFileSync(launcher, "echo safe\n");
  expect(run([git, "status", "--porcelain"], repository).stdout.toString()).toContain("?? launch.cmd");

  const incidentPath = join(directory, "git-clean-incident.json");
  writeFileSync(incidentPath, JSON.stringify({
    incident_id: "no-git-clean",
    class: "A",
    chokepoint: "shell",
    command: "git clean",
    condition: "untracked operational files are present",
    evidence_refs: ["demo:burn:1"],
    severity: 5,
    frequency: 1,
    recency: "2026-07-18",
  }));
  const compiled = run(["bun", cliPath, "compile", incidentPath], repository, { ...process.env, VIBEBLOAT_HOME: home });
  expect(compiled.exitCode).toBe(0);
  expect(JSON.parse(compiled.stdout.toString())).toMatchObject({ status: "pass" });
  expect(existsSync(join(home, "guards", "no-git-clean.json"))).toBe(true);

  const command = `bun ${JSON.stringify(cliPath)} hook`;
  installNativeHooks({
    permitted: true,
    claudePath: join(directory, "claude", "settings.json"),
    codexPath: join(directory, "codex", "config.toml"),
    command,
    fallback: {
      shimDirectory,
      readPath: (configuredShell) => configuredShell === "pwsh" ? `${shimDirectory};C:/Windows` : `${posixShimDirectory}:/usr/bin`,
      gitHookPaths: [],
      gitExecutable: git,
    },
  });
  expect(JSON.parse(readFileSync(join(directory, "claude", "settings.json"), "utf8"))).toMatchObject({
    hooks: { PreToolUse: [{ hooks: [{ command }] }] },
  });

  const hook = Bun.spawnSync(["bun", cliPath, "hook"], {
    cwd: repository,
    env: { ...process.env, VIBEBLOAT_HOME: home },
    stdin: new Blob([JSON.stringify({ tool_input: { command: "git clean -fd" } })]),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(hook.exitCode).toBe(2);
  expect(hook.stderr.toString()).toContain("VibeBloat found no-git-clean in 1 incident.");

  const shim = run([sh, join(shimDirectory, "git"), "clean", "-fd"], repository, {
    ...process.env,
    BUN_EXECUTABLE: process.execPath.replaceAll("\\", "/"),
    VIBEBLOAT_HOME: home,
  });
  expect(shim.exitCode).toBe(2);
  expect(shim.stderr.toString()).toContain("VibeBloat found no-git-clean in 1 incident.");
  expect(existsSync(launcher)).toBe(true);
  expect(run([git, "status", "--porcelain"], repository).stdout.toString()).toContain("?? launch.cmd");
});
