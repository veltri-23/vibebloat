import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowOnce } from "../src/runtime/override";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function invoke(home: string, mode: string, args: string[] = [], payload?: unknown) {
  return Bun.spawnSync(["bun", "src/cli.ts", mode, ...args], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, USERPROFILE: join(home, "user"), HOME: join(home, "user"), VIBEBLOAT_HOME: home },
    stdin: payload === undefined ? undefined : new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function installGuard(home: string): void {
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "no-publish.json"), JSON.stringify({
    id: "no-publish", class: "A", provenance: { incident: "test", date: "2026-07-18", source: "test" },
    match: { chokepoint: "shell", command: "npm publish" },
    action: { type: "block", message: "Publish is blocked.", override: "vibebloat allow no-publish --once" }, enabled: true,
  }));
}

test("allow persists for the next matching hook only", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-allow-"));
  tempDirectories.push(home);
  installGuard(home);
  expect(invoke(home, "allow", ["no-publish", "--once"]).exitCode).toBe(0);
  expect(invoke(home, "hook", [], { tool_input: { command: "echo safe" } }).exitCode).toBe(0);
  expect(invoke(home, "hook", [], { tool_input: { command: "npm publish" } }).exitCode).toBe(0);
  const blocked = invoke(home, "hook", [], { tool_input: { command: "npm publish" } });
  expect(blocked.exitCode).toBe(2);
  expect(blocked.stderr.toString()).toContain("Publish is blocked.");
}, 15_000);

test("legacy persisted stash override allows the canonical guard once", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-allow-"));
  tempDirectories.push(home);
  allowOnce("git-stash-untracked", home);
  expect(invoke(home, "hook", [], { tool_input: { command: "git stash -u" } }).exitCode).toBe(0);
  expect(invoke(home, "hook", [], { tool_input: { command: "git stash -u" } }).exitCode).toBe(2);
});

test("allow rejects a malformed pending override at hook time", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-allow-"));
  tempDirectories.push(home);
  installGuard(home);
  expect(invoke(home, "allow", ["no-publish", "--once"]).exitCode).toBe(0);
  const state = readdirSync(join(home, "overrides"))[0];
  writeFileSync(join(home, "overrides", state), "{");
  const result = invoke(home, "hook", [], { tool_input: { command: "npm publish" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe("WHAT failed: guard hook evaluation stopped.\nWHY: guard runtime could not load or evaluate installed guards.\nFIX: vibebloat doctor\n");
});

test("allow writes and consumes the onboarding-selected repo guard home", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-allow-scope-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const user = join(root, "user");
  const home = join(project, ".vibebloat");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "END", answers: {}, scope: "repo" }));
  installGuard(home);
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  const environment = { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined };
  const allow = Bun.spawnSync(["bun", cli, "allow", "no-publish", "--once"], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
  expect(allow.exitCode).toBe(0);
  expect(readdirSync(join(home, "overrides"))).toHaveLength(1);
  expect(() => readdirSync(join(user, ".vibebloat", "overrides"))).toThrow();
  const hook = Bun.spawnSync(["bun", cli, "hook"], {
    cwd: project, env: environment, stdin: new Blob([JSON.stringify({ tool_input: { command: "npm publish" } })]), stdout: "pipe", stderr: "pipe",
  });
  expect(hook.exitCode).toBe(0);
});
