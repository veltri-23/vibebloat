import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function runHook(home: string, payload: unknown) {
  return Bun.spawnSync(["bun", "src/cli.ts", "hook"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function guard(id: string, command: string) {
  return {
    id, class: "A", provenance: { incident: "test", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command },
    action: { type: "block", message: `${id} is blocked.`, override: `vibebloat allow ${id} --once` }, enabled: true,
  };
}

test("hook loads a compiled guard from VIBEBLOAT_HOME", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-guards-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "no-publish.json"), JSON.stringify({
    id: "no-publish", class: "A", provenance: { incident: "test", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command: "npm publish" },
    action: { type: "block", message: "Publish is blocked.", override: "vibebloat allow no-publish --once" }, enabled: true,
  }));
  const result = runHook(home, { tool_input: { command: "npm publish" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Publish is blocked.");
});

test("hook fails closed when an installed guard is invalid", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-guards-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "broken.json"), "{");
  const result = runHook(home, { tool_input: { command: "echo safe" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Guard runtime failed closed");
});

test("hook layers global and project guards when no home override is set", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-layered-"));
  tempDirectories.push(root);
  const project = join(root, "project"); const user = join(root, "user");
  mkdirSync(join(project, ".vibebloat", "guards"), { recursive: true });
  mkdirSync(join(user, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(project, ".vibebloat", "guards", "project.json"), JSON.stringify(guard("project-guard", "npm install")));
  writeFileSync(join(user, ".vibebloat", "guards", "global.json"), JSON.stringify(guard("global-guard", "npm publish")));
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  const projectResult = Bun.spawnSync(["bun", cli, "hook"], { cwd: project, env: { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined }, stdin: new Blob([JSON.stringify({ tool_input: { command: "npm install" } })]), stdout: "pipe", stderr: "pipe" });
  const globalResult = Bun.spawnSync(["bun", cli, "hook"], { cwd: project, env: { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined }, stdin: new Blob([JSON.stringify({ tool_input: { command: "npm publish" } })]), stdout: "pipe", stderr: "pipe" });
  expect(projectResult.exitCode).toBe(2);
  expect(globalResult.exitCode).toBe(2);
});

test("hook fails closed when global and project guards duplicate an id", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-duplicate-"));
  tempDirectories.push(root);
  const project = join(root, "project"); const user = join(root, "user");
  mkdirSync(join(project, ".vibebloat", "guards"), { recursive: true });
  mkdirSync(join(user, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(project, ".vibebloat", "guards", "project.json"), JSON.stringify(guard("duplicate", "npm install")));
  writeFileSync(join(user, ".vibebloat", "guards", "global.json"), JSON.stringify(guard("duplicate", "npm publish")));
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "hook"], { cwd: project, env: { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined }, stdin: new Blob([JSON.stringify({ tool_input: { command: "echo safe" } })]), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("duplicates built-in id: duplicate");
});
