import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPull, fetchAndPlanPull, GuardSyncError, planPush, type PullPlan } from "../src/sync";
import type { GitExecutor, GitResult } from "../src/sync/git";
import type { Guard } from "../src/types";

function guard(id: string, command = "git stash -u"): Guard {
  return {
    schemaVersion: 1,
    id,
    class: "A",
    provenance: { incident: "scrubbed", date: "2026-07-18", source: "repository" },
    match: { chokepoint: "shell", command },
    action: { type: "block", message: "stop", override: `vibebloat allow ${id} --once` },
    confidence: "high",
    tier: "local",
    binds: ["claude-code", "codex"],
    enabled: true,
  };
}

const json = (value: unknown): string => `${JSON.stringify(value)}\n`;

interface FakeState {
  head?: string;
  upstreamCommit?: string;
  ahead?: number;
  behind?: number;
  status?: string;
  operation?: string;
  trees?: Record<string, Record<string, string>>;
  merge?: (commit: string) => void;
}

class FakeGit implements GitExecutor {
  readonly calls: string[][] = [];
  readonly state: Required<Omit<FakeState, "merge">> & Pick<FakeState, "merge">;

  constructor(state: FakeState = {}) {
    this.state = {
      head: state.head ?? "a".repeat(40),
      upstreamCommit: state.upstreamCommit ?? "b".repeat(40),
      ahead: state.ahead ?? 0,
      behind: state.behind ?? 1,
      status: state.status ?? "",
      operation: state.operation ?? "",
      trees: state.trees ?? {},
      merge: state.merge,
    };
  }

  run(args: readonly string[], cwd: string): GitResult {
    this.calls.push([...args]);
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return ok(cwd);
    if (args[0] === "rev-parse" && args[1] === "--quiet") return args[3] === this.state.operation ? ok(this.state.head) : fail();
    if (command === "ls-files --unmerged") return ok();
    if (command === "status --porcelain=v1 --untracked-files=all -- .vibebloat/guards :(exclude).vibebloat/guards/proof.json") return ok(this.state.status);
    if (command === "symbolic-ref --quiet --short HEAD") return ok("task/demo");
    if (command === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return ok("origin/task/demo");
    if (command.startsWith("for-each-ref --format=%(upstream:remotename)")) return ok("origin");
    if (command.startsWith("for-each-ref --format=%(upstream:remoteref)")) return ok("refs/heads/task/demo");
    if (command === "rev-parse HEAD") return ok(this.state.head);
    if (command === "rev-parse @{upstream}") return ok(this.state.upstreamCommit);
    if (command === "fetch --no-tags -- origin") return ok();
    if (command === "rev-list --left-right --count HEAD...@{upstream}") return ok(`${this.state.ahead}\t${this.state.behind}`);
    if (args[0] === "ls-tree") return { exitCode: 0, stdout: treeOutput(this.state.trees[args[3]] ?? {}), stderr: "" };
    if (args[0] === "show") {
      const [commit, ...path] = args[1].split(":");
      const content = this.state.trees[commit]?.[path.join(":")];
      return content === undefined ? fail("missing") : ok(content);
    }
    if (args[0] === "merge") {
      this.state.merge?.(args[3]);
      this.state.head = args[3];
      return ok();
    }
    return fail(`unexpected git command: ${command}`);
  }
}

function ok(stdout = ""): GitResult {
  return { exitCode: 0, stdout: stdout ? `${stdout.replace(/\n$/, "")}\n` : "", stderr: "" };
}

function fail(stderr = "not found"): GitResult {
  return { exitCode: 1, stdout: "", stderr };
}

function treeOutput(files: Record<string, string>): string {
  return Object.keys(files).sort().map((path) => `100644 blob ${"1".repeat(40)}\t${path}\0`).join("");
}

function setup(): { root: string; head: string; upstream: string; before: string; after: string } {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-sync-"));
  const head = "a".repeat(40);
  const upstream = "b".repeat(40);
  const before = json(guard("old-guard"));
  const after = json(guard("new-guard", "npm publish"));
  return { root, head, upstream, before, after };
}

test("pull fetches only configured remote and previews validated guard IDs", () => {
  const { root, head, upstream, before, after } = setup();
  const git = new FakeGit({
    head,
    upstreamCommit: upstream,
    trees: {
      [head]: { ".vibebloat/guards/old-guard.json": before },
      [upstream]: { ".vibebloat/guards/new-guard.json": after },
    },
  });

  const plan = fetchAndPlanPull(root, git);

  expect(plan.status).toBe("ready");
  expect(plan.diff).toEqual({ added: ["new-guard"], changed: [], removed: ["old-guard"] });
  expect(git.calls).toContainEqual(["fetch", "--no-tags", "--", "origin"]);
  expect(git.calls.some((args) => args.includes("push") || args.includes("reset") || args.includes("rebase"))).toBeFalse();
});

test("dirty repository guards stop before fetch or mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-sync-dirty-"));
  const git = new FakeGit({ status: " M .vibebloat/guards/local.json" });

  expect(() => fetchAndPlanPull(root, git)).toThrow(GuardSyncError);
  expect(git.calls.some((args) => args[0] === "fetch")).toBeFalse();
});

test("symlinked guard roots stop before fetch or mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-sync-link-"));
  const outside = mkdtempSync(join(tmpdir(), "vibebloat-sync-outside-"));
  mkdirSync(join(root, ".vibebloat"));
  symlinkSync(outside, join(root, ".vibebloat", "guards"), "junction");
  const git = new FakeGit();

  expect(() => fetchAndPlanPull(root, git)).toThrow("symbolic-link guard directory");
  expect(git.calls.some((args) => args[0] === "fetch")).toBeFalse();
});

test("invalid or non-declarative remote entries stop before fast-forward", () => {
  const { root, head, upstream } = setup();
  const git = new FakeGit({
    head,
    upstreamCommit: upstream,
    trees: {
      [head]: {},
      [upstream]: { ".vibebloat/guards/proof.json": "{}\n" },
    },
  });

  expect(() => fetchAndPlanPull(root, git)).toThrow("non-declarative entry");
  expect(git.calls.some((args) => args[0] === "merge")).toBeFalse();
});

test("divergence stops without merge, rebase, force, or push", () => {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-sync-diverged-"));
  const git = new FakeGit({ ahead: 1, behind: 1 });

  expect(() => fetchAndPlanPull(root, git)).toThrow("histories diverged");
  expect(git.calls.some((args) => ["merge", "rebase", "push", "reset"].includes(args[0]))).toBeFalse();
});

test("push returns direct argv but never executes it", () => {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-sync-push-"));
  const git = new FakeGit({ ahead: 2, behind: 0 });

  const plan = planPush(root, git);

  expect(plan.argv).toEqual(["push", "--", "origin", "task/demo:refs/heads/task/demo"]);
  expect(git.calls.some((args) => args[0] === "push")).toBeFalse();
});

test("doctor failure restores previous tracked guards and preserves local proof", () => {
  const { root, head, upstream, before, after } = setup();
  const directory = join(root, ".vibebloat", "guards");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "old-guard.json"), before);
  writeFileSync(join(directory, "proof.json"), "local-only\n");
  const git = new FakeGit({
    head,
    upstreamCommit: upstream,
    trees: {
      [head]: { ".vibebloat/guards/old-guard.json": before },
      [upstream]: { ".vibebloat/guards/new-guard.json": after },
    },
    merge() {
      writeFileSync(join(directory, "new-guard.json"), after);
      writeFileSync(join(directory, "old-guard.json"), "partially changed");
    },
  });
  const plan = fetchAndPlanPull(root, git);
  const reloads: string[] = [];

  expect(() => applyPull(plan, {
    git,
    reload(path) {
      reloads.push(readFileSync(join(path, reloads.length === 0 ? "new-guard.json" : "old-guard.json"), "utf8"));
    },
    doctor: () => false,
  })).toThrow("guard pull rolled back");
  expect(readFileSync(join(directory, "old-guard.json"), "utf8")).toBe(before);
  expect(readFileSync(join(directory, "proof.json"), "utf8")).toBe("local-only\n");
  expect(() => readFileSync(join(directory, "new-guard.json"), "utf8")).toThrow();
  expect(git.state.head).toBe(head);
  expect(git.calls.some((args) => args[0] === "merge")).toBeFalse();
  expect(reloads).toEqual([after, before]);
});

test("reload failure restores previous guards and runtime before fast-forward", () => {
  const { root, head, upstream, before, after } = setup();
  const directory = join(root, ".vibebloat", "guards");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "old-guard.json"), before);
  const git = new FakeGit({
    head,
    upstreamCommit: upstream,
    trees: {
      [head]: { ".vibebloat/guards/old-guard.json": before },
      [upstream]: { ".vibebloat/guards/new-guard.json": after },
    },
  });
  const plan = fetchAndPlanPull(root, git);
  let reloads = 0;

  expect(() => applyPull(plan, {
    git,
    reload(path) {
      reloads += 1;
      if (reloads === 1) throw new Error("reload failed");
      expect(readFileSync(join(path, "old-guard.json"), "utf8")).toBe(before);
    },
    doctor: () => true,
  })).toThrow("guard pull rolled back");

  expect(reloads).toBe(2);
  expect(git.state.head).toBe(head);
  expect(git.calls.some((args) => args[0] === "merge")).toBeFalse();
  expect(readFileSync(join(directory, "old-guard.json"), "utf8")).toBe(before);
  expect(() => readFileSync(join(directory, "new-guard.json"), "utf8")).toThrow();
});

test("successful pull reloads exact candidate before doctor", () => {
  const { root, head, upstream, before, after } = setup();
  const directory = join(root, ".vibebloat", "guards");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "old-guard.json"), before);
  const git = new FakeGit({
    head,
    upstreamCommit: upstream,
    trees: {
      [head]: { ".vibebloat/guards/old-guard.json": before },
      [upstream]: { ".vibebloat/guards/new-guard.json": after },
    },
  });
  const plan = fetchAndPlanPull(root, git);
  const events: string[] = [];

  const result = applyPull(plan, {
    git,
    reload(path) {
      events.push(`reload:${path}`);
      expect(readFileSync(join(path, "new-guard.json"), "utf8")).toBe(after);
    },
    doctor() {
      events.push("doctor");
      return true;
    },
  });

  expect(result).toEqual({ applied: true, commit: upstream, diff: plan.diff });
  expect(events).toEqual([`reload:${directory}`, "doctor"]);
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

test("failed validation preserves clone HEAD before successful convergence", () => {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-sync-git-"));
  const origin = join(root, "origin.git");
  const owner = join(root, "owner");
  const consumer = join(root, "consumer");
  try {
    mkdirSync(owner);
    git(root, "init", "--bare", origin);
    git(owner, "init", "-b", "main");
    git(owner, "config", "user.name", "VibeBloat Test");
    git(owner, "config", "user.email", "vibebloat@example.invalid");
    const guardDirectory = join(owner, ".vibebloat", "guards");
    mkdirSync(guardDirectory, { recursive: true });
    writeFileSync(join(guardDirectory, "old-guard.json"), json(guard("old-guard")));
    git(owner, "add", ".vibebloat/guards/old-guard.json");
    git(owner, "commit", "-s", "-m", "add old guard");
    git(owner, "remote", "add", "origin", origin);
    git(owner, "push", "-u", "origin", "main");
    git(root, "clone", origin, consumer);
    git(consumer, "switch", "main");
    writeFileSync(join(consumer, ".vibebloat", "guards", "proof.json"), "local-only\n");

    rmSync(join(guardDirectory, "old-guard.json"));
    writeFileSync(join(guardDirectory, "new-guard.json"), json(guard("new-guard", "npm publish")));
    git(owner, "add", "-A", ".vibebloat/guards");
    git(owner, "commit", "-s", "-m", "replace guard");
    git(owner, "push");

    const plan = fetchAndPlanPull(consumer);
    const originalHead = git(consumer, "rev-parse", "HEAD");
    const originalStatus = git(consumer, "status", "--porcelain=v1", "--untracked-files=all");
    expect(() => applyPull(plan, { reload: () => {}, doctor: () => false })).toThrow("guard pull rolled back");
    expect(git(consumer, "rev-parse", "HEAD")).toBe(originalHead);
    expect(git(consumer, "status", "--porcelain=v1", "--untracked-files=all")).toBe(originalStatus);
    expect(readFileSync(join(consumer, ".vibebloat", "guards", "old-guard.json"), "utf8")).toContain('"id":"old-guard"');
    expect(() => readFileSync(join(consumer, ".vibebloat", "guards", "new-guard.json"), "utf8")).toThrow();

    const result = applyPull(plan, {
      reload(path) {
        expect(readFileSync(join(path, "new-guard.json"), "utf8")).toContain('"id":"new-guard"');
      },
      doctor: () => true,
    });

    expect(result.applied).toBeTrue();
    expect(git(consumer, "rev-parse", "HEAD")).toBe(git(owner, "rev-parse", "HEAD"));
    expect(() => readFileSync(join(consumer, ".vibebloat", "guards", "old-guard.json"), "utf8")).toThrow();
    expect(readFileSync(join(consumer, ".vibebloat", "guards", "proof.json"), "utf8")).toBe("local-only\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
