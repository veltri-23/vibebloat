import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { parseGuard } from "../schema";
import type { Guard } from "../types";
import { bunGitExecutor, type GitExecutor, type GitResult } from "./git";

const guardPrefix = ".vibebloat/guards/";
const guardFilePattern = /^\.vibebloat\/guards\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

export class GuardSyncError extends Error {
  readonly what: string;
  readonly why: string;
  readonly fix: string;

  constructor(what: string, why: string, fix: string, options?: ErrorOptions) {
    const clean = (value: string) => value.replace(/\s+/g, " ").replace(/\.+$/, "").trim();
    super(`WHAT failed: ${clean(what)}.\nWHY: ${clean(why)}.\nFIX: ${clean(fix)}`, options);
    this.name = "GuardSyncError";
    this.what = what;
    this.why = why;
    this.fix = fix;
  }
}

export interface GuardSyncDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface GuardSnapshotFile {
  path: string;
  content: string;
  guard: Guard;
}

export interface GuardSnapshot {
  commit: string;
  files: GuardSnapshotFile[];
}

interface SyncIdentity {
  repository: string;
  branch: string;
  upstream: string;
  remote: string;
  remoteBranch: string;
  head: string;
  upstreamCommit: string;
}

export interface PullPlan extends SyncIdentity {
  direction: "pull";
  status: "ready" | "current";
  commitsBehind: number;
  diff: GuardSyncDiff;
  current: GuardSnapshot;
  candidate: GuardSnapshot;
}

export interface PushPlan extends SyncIdentity {
  direction: "push";
  status: "ready" | "current";
  commitsAhead: number;
  argv?: readonly string[];
}

export interface ApplyPullOptions {
  git?: GitExecutor;
  reload: (guardDirectory: string) => unknown;
  doctor: (repository: string) => boolean | void;
}

export interface PullResult {
  applied: boolean;
  commit: string;
  diff: GuardSyncDiff;
}

function failure(what: string, why: string, fix: string, cause?: unknown): GuardSyncError {
  return new GuardSyncError(what, why, fix, cause === undefined ? undefined : { cause });
}

function run(git: GitExecutor, args: readonly string[], cwd: string, what: string): GitResult {
  const result = git.run(args, cwd);
  if (result.exitCode !== 0) {
    const why = result.stderr.trim() || result.stdout.trim() || "Git returned a nonzero exit code";
    throw failure(what, why, "git status");
  }
  return result;
}

function output(git: GitExecutor, args: readonly string[], cwd: string, what: string): string {
  return run(git, args, cwd, what).stdout.trim();
}

function repositoryRoot(cwd: string, git: GitExecutor): string {
  const result = git.run(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0 || !isAbsolute(result.stdout.trim())) {
    throw failure("guard sync cannot start", "current directory is not inside a Git worktree", "git status");
  }
  return resolve(result.stdout.trim());
}

function assertNoOperation(repository: string, git: GitExecutor): void {
  for (const ref of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"]) {
    if (git.run(["rev-parse", "--quiet", "--verify", ref], repository).exitCode === 0) {
      throw failure("guard sync cannot start", `repository has an unfinished ${ref.replace("_HEAD", "").toLowerCase()} operation`, "git status");
    }
  }
  const conflicts = run(git, ["ls-files", "--unmerged"], repository, "guard sync preflight could not inspect conflicts");
  if (conflicts.stdout.trim()) {
    throw failure("guard sync cannot start", "repository contains unresolved conflicts", "git status");
  }
}

function assertCleanGuards(repository: string, git: GitExecutor): void {
  assertSafeGuardRoot(repository);
  const result = run(
    git,
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".vibebloat/guards",
      ":(exclude).vibebloat/guards/proof.json",
    ],
    repository,
    "guard sync preflight could not inspect repository guards",
  );
  if (result.stdout.trim()) {
    throw failure("guard sync cannot start", "repository guards contain tracked, untracked, or conflicted changes", "git status -- .vibebloat/guards");
  }
}

function identity(repository: string, git: GitExecutor): SyncIdentity {
  assertNoOperation(repository, git);
  assertCleanGuards(repository, git);
  const branchResult = git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], repository);
  if (branchResult.exitCode !== 0 || !branchResult.stdout.trim()) {
    throw failure("guard sync cannot start", "detached HEAD has no checked-out branch", "git switch <branch>");
  }
  const branch = branchResult.stdout.trim();
  const upstreamResult = git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repository);
  if (upstreamResult.exitCode !== 0 || !upstreamResult.stdout.trim()) {
    throw failure("guard sync cannot start", "checked-out branch has no configured upstream", `git push --set-upstream <remote> ${branch}`);
  }
  const upstream = upstreamResult.stdout.trim();
  const remote = output(
    git,
    ["for-each-ref", "--format=%(upstream:remotename)", `refs/heads/${branch}`],
    repository,
    "guard sync could not resolve configured remote",
  );
  const remoteBranch = output(
    git,
    ["for-each-ref", "--format=%(upstream:remoteref)", `refs/heads/${branch}`],
    repository,
    "guard sync could not resolve upstream branch",
  ).replace(/^refs\/heads\//, "");
  if (!remote || !remoteBranch) {
    throw failure("guard sync cannot start", "configured upstream has no remote and branch mapping", `git branch --set-upstream-to=${upstream}`);
  }
  return {
    repository,
    branch,
    upstream,
    remote,
    remoteBranch,
    head: output(git, ["rev-parse", "HEAD"], repository, "guard sync could not resolve HEAD"),
    upstreamCommit: output(git, ["rev-parse", "@{upstream}"], repository, "guard sync could not resolve upstream commit"),
  };
}

function counts(repository: string, git: GitExecutor): { ahead: number; behind: number } {
  const value = output(git, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], repository, "guard sync could not compare local and upstream history");
  const match = /^(\d+)\s+(\d+)$/.exec(value);
  if (!match) throw failure("guard sync could not compare histories", "Git returned an invalid ahead/behind count", "git status");
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

function assertNotDiverged(ahead: number, behind: number): void {
  if (ahead > 0 && behind > 0) {
    throw failure("guard sync stopped", "local and upstream histories diverged; automatic merge, rebase, and force are forbidden", "git log --oneline --left-right HEAD...@{upstream}");
  }
}

function parseTree(stdout: string): Array<{ path: string; mode: string; type: string }> {
  if (!stdout) return [];
  return stdout.split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d+) ([^ ]+) [0-9a-f]+\t([\s\S]+)$/.exec(entry);
    if (!match) throw failure("guard snapshot validation stopped", "Git returned an invalid tree entry", "git fsck");
    return { mode: match[1], type: match[2], path: match[3] };
  });
}

function validateSnapshotPath(path: string, mode: string, type: string): string {
  const match = guardFilePattern.exec(path);
  if (!match || basename(path) === "proof.json" || mode !== "100644" || type !== "blob") {
    throw failure(
      "guard snapshot validation stopped",
      `sync surface contains non-declarative entry ${path}`,
      "git diff HEAD..@{upstream} -- .vibebloat/guards",
    );
  }
  return match[1];
}

function snapshot(repository: string, commit: string, git: GitExecutor): GuardSnapshot {
  const tree = run(
    git,
    ["ls-tree", "-rz", "--full-tree", commit, "--", ".vibebloat/guards"],
    repository,
    "guard snapshot could not be read",
  );
  const files = parseTree(tree.stdout).map(({ path, mode, type }) => {
    const expectedId = validateSnapshotPath(path, mode, type);
    const content = run(git, ["show", `${commit}:${path}`], repository, "guard snapshot file could not be read").stdout;
    let guard: Guard;
    try {
      guard = parseGuard(JSON.parse(content));
    } catch (error) {
      throw failure("guard snapshot validation stopped", `${path} is not a valid closed-schema guard`, "git diff HEAD..@{upstream} -- .vibebloat/guards", error);
    }
    if (guard.id !== expectedId) {
      throw failure("guard snapshot validation stopped", `${path} does not match guard id ${guard.id}`, "git diff HEAD..@{upstream} -- .vibebloat/guards");
    }
    return { path, content, guard };
  });
  const ids = files.map(({ guard }) => guard.id);
  if (new Set(ids).size !== ids.length) {
    throw failure("guard snapshot validation stopped", "snapshot contains duplicate guard IDs", "git diff HEAD..@{upstream} -- .vibebloat/guards");
  }
  return { commit, files };
}

function diffSnapshots(current: GuardSnapshot, candidate: GuardSnapshot): GuardSyncDiff {
  const before = new Map(current.files.map((file) => [file.guard.id, file.content]));
  const after = new Map(candidate.files.map((file) => [file.guard.id, file.content]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)).sort(),
    changed: [...after.keys()].filter((id) => before.has(id) && before.get(id) !== after.get(id)).sort(),
    removed: [...before.keys()].filter((id) => !after.has(id)).sort(),
  };
}

export function fetchAndPlanPull(cwd: string, git: GitExecutor = bunGitExecutor): PullPlan {
  const repository = repositoryRoot(cwd, git);
  const beforeFetch = identity(repository, git);
  run(git, ["fetch", "--no-tags", "--", beforeFetch.remote], repository, "configured upstream fetch failed");
  const afterFetch = identity(repository, git);
  if (beforeFetch.branch !== afterFetch.branch || beforeFetch.head !== afterFetch.head || beforeFetch.upstream !== afterFetch.upstream) {
    throw failure("guard sync stopped", "branch, HEAD, or upstream changed during fetch", "git status");
  }
  const { ahead, behind } = counts(repository, git);
  assertNotDiverged(ahead, behind);
  if (ahead > 0) {
    throw failure("guard pull stopped", "local branch is ahead of upstream and has nothing to fast-forward", "git status --short --branch");
  }
  const current = snapshot(repository, afterFetch.head, git);
  const candidate = snapshot(repository, afterFetch.upstreamCommit, git);
  return {
    ...afterFetch,
    direction: "pull",
    status: behind === 0 ? "current" : "ready",
    commitsBehind: behind,
    diff: diffSnapshots(current, candidate),
    current,
    candidate,
  };
}

export function planPush(cwd: string, git: GitExecutor = bunGitExecutor): PushPlan {
  const repository = repositoryRoot(cwd, git);
  const state = identity(repository, git);
  const { ahead, behind } = counts(repository, git);
  assertNotDiverged(ahead, behind);
  if (behind > 0) {
    throw failure("guard push stopped", "upstream is ahead; pushing would not be a fast-forward", "vibebloat sync --pull");
  }
  return {
    ...state,
    direction: "push",
    status: ahead === 0 ? "current" : "ready",
    commitsAhead: ahead,
    argv: ahead === 0 ? undefined : ["push", "--", state.remote, `${state.branch}:refs/heads/${state.remoteBranch}`],
  };
}

function guardPath(repository: string, path: string): string {
  if (!path.startsWith(guardPrefix) || path.includes("\\")) throw new Error(`Unsafe guard path: ${path}`);
  const target = resolve(repository, ...path.split("/"));
  const root = resolve(repository, ".vibebloat", "guards");
  const child = relative(root, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error(`Unsafe guard path: ${path}`);
  return target;
}

function assertSafeGuardRoot(repository: string): void {
  for (const path of [join(repository, ".vibebloat"), join(repository, ".vibebloat", "guards")]) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error(`Refusing symbolic-link guard directory: ${path}`);
  }
}

function assertSafeManagedPaths(repository: string, snapshots: readonly GuardSnapshot[]): void {
  assertSafeGuardRoot(repository);
  for (const path of new Set(snapshots.flatMap((snapshot) => snapshot.files.map((file) => file.path)))) {
    const target = guardPath(repository, path);
    if (!existsSync(target)) continue;
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-file guard target: ${target}`);
  }
}

function temporaryGuardDirectory(repository: string, suffix: "candidate" | "backup" | "rejected"): string {
  const root = resolve(repository, ".vibebloat");
  const target = join(root, `.guards.${randomUUID()}.vibebloat-sync-${suffix}`);
  const child = relative(root, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Unsafe temporary guard directory.");
  return target;
}

function removeTemporaryGuardDirectory(repository: string, path: string): void {
  const root = resolve(repository, ".vibebloat");
  const target = resolve(path);
  const child = relative(root, target);
  if (!/^\.guards\.[0-9a-f-]+\.vibebloat-sync-(?:candidate|backup|rejected)$/.test(child)) {
    throw new Error(`Refusing unsafe temporary guard cleanup: ${target}`);
  }
  if (!existsSync(target)) return;
  rmSync(target, lstatSync(target).isSymbolicLink() ? { force: true } : { recursive: true, force: true });
}

function activateCandidateSnapshot(repository: string, target: GuardSnapshot): () => void {
  assertSafeGuardRoot(repository);
  const root = resolve(repository, ".vibebloat");
  const live = join(root, "guards");
  const candidate = temporaryGuardDirectory(repository, "candidate");
  const backup = temporaryGuardDirectory(repository, "backup");
  const hadLive = existsSync(live);
  if (hadLive && !lstatSync(live).isDirectory()) throw new Error(`Refusing non-directory guard root: ${live}`);
  mkdirSync(candidate, { recursive: true });
  try {
    for (const file of target.files) {
      const destination = join(candidate, basename(file.path));
      writeFileSync(destination, file.content);
      chmodSync(destination, 0o644);
    }
    const proof = join(live, "proof.json");
    if (existsSync(proof)) {
      const stat = lstatSync(proof);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Refusing non-file local proof: ${proof}`);
      const stagedProof = join(candidate, "proof.json");
      copyFileSync(proof, stagedProof);
      chmodSync(stagedProof, stat.mode);
    }
    if (hadLive) renameSync(live, backup);
    renameSync(candidate, live);
  } catch (error) {
    if (!existsSync(live) && existsSync(backup)) {
      renameSync(backup, live);
    }
    removeTemporaryGuardDirectory(repository, candidate);
    removeTemporaryGuardDirectory(repository, backup);
    throw error;
  }

  let restored = false;
  return () => {
    if (restored) return;
    const rejected = temporaryGuardDirectory(repository, "rejected");
    if (existsSync(live)) renameSync(live, rejected);
    try {
      if (hadLive) renameSync(backup, live);
    } catch (error) {
      if (!existsSync(live) && existsSync(rejected)) renameSync(rejected, live);
      throw error;
    }
    removeTemporaryGuardDirectory(repository, rejected);
    removeTemporaryGuardDirectory(repository, candidate);
    removeTemporaryGuardDirectory(repository, backup);
    restored = true;
  };
}

function assertPlanCurrent(plan: PullPlan, git: GitExecutor): void {
  const state = identity(plan.repository, git);
  if (state.branch !== plan.branch || state.upstream !== plan.upstream || state.head !== plan.head || state.upstreamCommit !== plan.upstreamCommit) {
    throw failure("guard pull stopped", "reviewed pull plan is stale", "vibebloat sync --pull");
  }
}

function assertPreparedSnapshot(snapshot: GuardSnapshot): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(snapshot.commit)) throw new Error("Invalid prepared guard snapshot commit.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    const expectedId = validateSnapshotPath(file.path, "100644", "blob");
    const parsed = parseGuard(JSON.parse(file.content));
    if (parsed.id !== expectedId || file.guard.id !== expectedId) throw new Error(`Prepared guard snapshot identity mismatch: ${file.path}`);
    if (ids.has(expectedId) || paths.has(file.path)) throw new Error("Prepared guard snapshot contains duplicate entries.");
    ids.add(expectedId);
    paths.add(file.path);
  }
}

export function applyPull(plan: PullPlan, options: ApplyPullOptions): PullResult {
  const git = options.git ?? bunGitExecutor;
  if (plan.current.commit !== plan.head || plan.candidate.commit !== plan.upstreamCommit) {
    throw failure("guard pull stopped", "reviewed snapshots do not match reviewed commits", "vibebloat sync --pull");
  }
  try {
    assertPreparedSnapshot(plan.current);
    assertPreparedSnapshot(plan.candidate);
    assertSafeManagedPaths(plan.repository, [plan.current, plan.candidate]);
  } catch (error) {
    throw failure("guard pull stopped", "reviewed guard snapshot failed integrity validation", "vibebloat sync --pull", error);
  }
  if (plan.status === "current") return { applied: false, commit: plan.head, diff: plan.diff };
  assertPlanCurrent(plan, git);
  let restore: () => void;
  try {
    restore = activateCandidateSnapshot(plan.repository, plan.candidate);
  } catch (error) {
    throw failure("guard pull rolled back", "candidate guards could not be activated before fast-forward", "vibebloat doctor", error);
  }
  try {
    options.reload(join(plan.repository, ".vibebloat", "guards"));
    const healthy = options.doctor(plan.repository);
    if (healthy === false) throw new Error("doctor reported unhealthy state");
  } catch (error) {
    try {
      restore();
      options.reload(join(plan.repository, ".vibebloat", "guards"));
    } catch (rollbackError) {
      throw failure("guard pull failed and rollback was incomplete", "candidate activation failed and previous guard snapshot or runtime could not be restored", "git status", rollbackError);
    }
    throw failure("guard pull rolled back", "candidate guards failed validation, reload, or doctor before fast-forward", "vibebloat doctor", error);
  }

  try {
    restore();
  } catch (error) {
    throw failure("guard pull failed and rollback was incomplete", "candidate passed validation but previous guard snapshot could not be restored before fast-forward", "git status", error);
  }

  try {
    assertPlanCurrent(plan, git);
    const merge = git.run(["merge", "--ff-only", "--", plan.upstreamCommit], plan.repository);
    if (merge.exitCode !== 0) {
      throw failure("guard pull stopped", merge.stderr.trim() || "Git refused the fast-forward update", "git status");
    }
  } catch (error) {
    try {
      options.reload(join(plan.repository, ".vibebloat", "guards"));
    } catch (reloadError) {
      throw failure("guard pull failed and rollback was incomplete", "Git fast-forward stopped and previous runtime could not be restored", "vibebloat doctor", reloadError);
    }
    throw error;
  }
  return { applied: true, commit: plan.upstreamCommit, diff: plan.diff };
}
