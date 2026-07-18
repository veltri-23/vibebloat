import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function guard(id: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    id,
    class: "A",
    provenance: { incident: "scrubbed", date: "2026-07-18", source: "repository" },
    match: { chokepoint: "shell", command: "git status" },
    action: { type: "block", message: "stop", override: `vibebloat allow ${id} --once` },
    confidence: "high",
    tier: "local",
    binds: ["claude-code", "codex"],
    enabled: true,
  })}\n`;
}

function fixture(): { root: string; owner: string; consumer: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-sync-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const owner = join(root, "owner");
  const consumer = join(root, "consumer");
  mkdirSync(owner);
  git(root, "init", "--bare", origin);
  git(owner, "init", "-b", "main");
  git(owner, "config", "user.name", "VibeBloat Test");
  git(owner, "config", "user.email", "vibebloat@example.invalid");
  mkdirSync(join(owner, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(owner, ".vibebloat", "guards", "old-guard.json"), guard("old-guard"));
  git(owner, "add", ".vibebloat/guards/old-guard.json");
  git(owner, "commit", "-s", "-m", "old guard");
  git(owner, "remote", "add", "origin", origin);
  git(owner, "push", "-u", "origin", "main");
  git(root, "clone", origin, consumer);
  git(consumer, "switch", "main");
  writeFileSync(join(consumer, ".vibebloat", "guards", "proof.json"), "{}\n");
  const claude = join(root, "claude");
  const codex = join(root, "codex");
  mkdirSync(claude); mkdirSync(codex);
  writeFileSync(join(claude, "settings.json"), "vibebloat hook");
  writeFileSync(join(codex, "config.toml"), "plugin_hooks = true\nvibebloat hook --agent=codex\n");
  const { HERMES_HOME: _hermesHome, OPENCLAW_SESSION: _openClawSession, ...baseEnvironment } = process.env;
  return {
    root,
    owner,
    consumer,
    env: { ...baseEnvironment, VIBEBLOAT_HOME: join(root, "home"), CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, USERPROFILE: root, HOME: root },
  };
}

test("sync --pull fast-forwards validated guards and preserves local proof", () => {
  const { owner, consumer, env } = fixture();
  rmSync(join(owner, ".vibebloat", "guards", "old-guard.json"));
  writeFileSync(join(owner, ".vibebloat", "guards", "new-guard.json"), guard("new-guard"));
  git(owner, "add", "-A", ".vibebloat/guards");
  git(owner, "commit", "-s", "-m", "new guard");
  git(owner, "push");

  const result = Bun.spawnSync(["bun", cli, "sync", "--pull"], { cwd: consumer, env, stdout: "pipe", stderr: "pipe" });

  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("Added: new-guard\nChanged: none\nRemoved: old-guard");
  expect(git(consumer, "rev-parse", "HEAD")).toBe(git(owner, "rev-parse", "HEAD"));
  expect(readFileSync(join(consumer, ".vibebloat", "guards", "proof.json"), "utf8")).toBe("{}\n");
}, 30_000);

test("sync failure is three safe lines and leaves HEAD unchanged", () => {
  const { root, owner, consumer, env } = fixture();
  const before = git(consumer, "rev-parse", "HEAD");
  writeFileSync(join(owner, ".vibebloat", "guards", "bad.json"), "{\"secret\":\"Bearer remote-secret\"}\n");
  git(owner, "add", ".vibebloat/guards/bad.json");
  git(owner, "commit", "-s", "-m", "bad guard");
  git(owner, "push");

  const result = Bun.spawnSync(["bun", cli, "sync", "--pull"], { cwd: consumer, env, stdout: "pipe", stderr: "pipe" });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString().split("\n").filter(Boolean)).toHaveLength(3);
  expect(result.stderr.toString()).not.toMatch(/remote-secret|Bearer|bad\.json|vibebloat-cli-sync/i);
  expect(result.stderr.toString()).toContain("WHY: configured upstream contains an invalid repository guard snapshot.");
  expect(git(consumer, "rev-parse", "HEAD")).toBe(before);
  expect(result.stderr.toString()).not.toContain(root);
}, 30_000);
