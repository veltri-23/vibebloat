import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { selectReleaseArtifact } from "../src/distribution/release";
import { installGitShellShim } from "../src/install/shell-shim";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("standalone executable services fallback shim without source files", () => {
  const project = join(import.meta.dir, "..");
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: project, stdout: "pipe", stderr: "pipe" });
  expect(build.exitCode).toBe(0);
  const artifact = selectReleaseArtifact(process.platform, process.arch);
  expect(artifact).toBeTruthy();
  const executable = join(project, "dist", artifact!.filename);
  expect(existsSync(executable)).toBeTrue();
  const git = Bun.which("git");
  expect(git).toBeTruthy();

  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-standalone-"));
  roots.push(root);
  const repository = join(root, "repo");
  const shimDirectory = join(root, "shim");
  mkdirSync(repository);
  expect(Bun.spawnSync([git!, "init", "--quiet"], { cwd: repository }).exitCode).toBe(0);
  writeFileSync(join(repository, "operational.txt"), "keep\n");
  installGitShellShim({ shimDirectory, gitExecutable: git!, selfCommand: [executable] });
  const shim = join(shimDirectory, process.platform === "win32" ? "git.cmd" : "git");
  const shimSource = readFileSync(shim, "utf8");
  expect(shimSource).not.toContain("src/");
  expect(shimSource).not.toContain(".ts");
  expect(shimSource).not.toContain(process.execPath.replaceAll("\\", "/"));

  const result = Bun.spawnSync(process.platform === "win32" ? [shim, "stash", "--all"] : ["sh", shim, "stash", "--all"], {
    cwd: repository,
    env: { ...process.env, USERPROFILE: join(root, "user"), HOME: join(root, "user") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("BLOCKED");
  expect(existsSync(join(repository, "operational.txt"))).toBeTrue();
}, 240_000);
