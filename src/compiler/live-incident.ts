import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { compileGuard } from "./codex-fill";
import { claimCompileBudget } from "./budget";
import { replaceGuardAtomically } from "./live-compile";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { applyAtomicFilePlans } from "../install/atomic-files";
import type { IncidentManifest } from "../ingest/rank";
import { detectRunnerDetails, type RunnerSignals } from "../onboarding/detect-runner";
import { Runtime } from "../runtime";
import { parseGuard } from "../schema";
import type { Guard } from "../types";

export interface GitTreeSnapshot {
  untrackedPaths: readonly string[];
}

export interface LiveGitObservation {
  command: string;
  exitCode: number;
  before: GitTreeSnapshot;
  after: GitTreeSnapshot;
  occurredAt: Date;
  /** The tree the command ran in. Scopes the compiled guard to this tree. */
  cwd?: string;
}

const approvalBrand: unique symbol = Symbol("human-live-compile-approval");

export interface HumanLiveCompileApproval {
  readonly [approvalBrand]: true;
  readonly incidentId: string;
  readonly reviewedGuardSha256: string;
}

export interface LiveProposalReview {
  incidentId: string;
  guard: Guard;
  guardSha256: string;
}

export interface LiveProposalResult {
  status: "proposed" | "queued" | "failed";
  incidentId: string;
  proposalPath?: string;
  warning?: string;
}

export interface ScheduledLiveProposal {
  status: "scheduled";
  incident: IncidentManifest;
  completion: Promise<LiveProposalResult>;
}

export interface LiveProposalDrainResult {
  proposed: number;
  queued: number;
  failed: number;
}

type Scheduler = (task: () => void) => void;

export interface LiveProposalOptions {
  scope?: GuardScope;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
}

export interface ScheduleLiveProposalOptions extends LiveProposalOptions {
  schedule?: Scheduler;
}

export interface LaunchLiveProposalOptions extends LiveProposalOptions {
  cliPath?: string;
  cliCommand?: readonly string[];
  launch?: (command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => void;
}

interface BoundProof {
  status: "pass";
  cases: string[];
  guardSha256: string;
}

interface ProposalLock {
  directory: string;
  token: string;
}

interface LockOwner {
  pid: number;
  token: string;
}

const guardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function runGit(gitExecutable: string, cwd: string, arguments_: readonly string[]): string {
  const result = Bun.spawnSync([gitExecutable, ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("Git tree snapshot failed.");
  return result.stdout.toString();
}

export function captureGitTreeSnapshot(cwd: string, gitExecutable = "git"): GitTreeSnapshot {
  const source = runGit(gitExecutable, cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  return {
    untrackedPaths: source
      .split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3))
      .sort(),
  };
}

function destructiveGitCommand(command: string): { id: string; matchCommand: string; argsAnyOf: string[] } | undefined {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git" || tokens.includes("--")) return undefined;
  const forceArguments = tokens.slice(2).filter((argument) => argument === "--force" || /^-[^-]*f/.test(argument));
  if (tokens[1] === "clean" && forceArguments.length > 0) {
    return {
      id: "live-git-clean-untracked",
      matchCommand: "git clean",
      argsAnyOf: [...new Set(["--force", "-f", "-fd", "-df", ...forceArguments])],
    };
  }
  if (tokens[1] === "stash" && tokens.slice(2).some((argument) => argument === "-u" || argument === "--include-untracked" || argument === "--all")) {
    return { id: "live-git-stash-untracked", matchCommand: "git stash", argsAnyOf: ["-u", "--include-untracked", "--all"] };
  }
  return undefined;
}

export function isLiveIncidentCandidate(command: string): boolean {
  return destructiveGitCommand(command) !== undefined;
}

export function detectLiveGitIncident(observation: LiveGitObservation): IncidentManifest | undefined {
  if (observation.exitCode !== 0) return undefined;
  const destructive = destructiveGitCommand(observation.command);
  if (!destructive) return undefined;
  const remaining = new Set(observation.after.untrackedPaths);
  const removedCount = observation.before.untrackedPaths.filter((path) => !remaining.has(path)).length;
  if (removedCount === 0) return undefined;
  const date = observation.occurredAt.toISOString().slice(0, 10);
  const cwdUnder = observation.cwd?.trim() ? observation.cwd.replace(/\\/g, "/").replace(/\/+$/, "") : undefined;
  return {
    incident_id: destructive.id,
    class: "A",
    chokepoint: "shell",
    command: destructive.matchCommand,
    condition: `${removedCount} untracked operational file${removedCount === 1 ? "" : "s"} left the live tree`,
    ...(cwdUnder ? { context_cwd_under: cwdUnder } : {}),
    evidence_refs: [`live-shell:${date}`],
    severity: 5,
    frequency: 1,
    recency: date,
  };
}

function compileDetectedGuard(incident: IncidentManifest): Guard {
  const sourceCommand = incident.incident_id === "live-git-clean-untracked"
    ? "git clean -fd"
    : incident.incident_id === "live-git-stash-untracked"
      ? "git stash -u"
      : undefined;
  const destructive = sourceCommand ? destructiveGitCommand(sourceCommand) : undefined;
  const expectedEvidence = `live-shell:${incident.recency}`;
  if (!destructive
    || incident.class !== "A"
    || incident.chokepoint !== "shell"
    || incident.command !== destructive.matchCommand
    || !/^\d+ untracked operational files? left the live tree$/.test(incident.condition)
    || incident.evidence_refs.length !== 1
    || incident.evidence_refs[0] !== expectedEvidence
    || !/^\d{4}-\d{2}-\d{2}$/.test(incident.recency)
    || incident.severity !== 5
    || incident.frequency !== 1) {
    throw new Error("Live incident manifest is invalid.");
  }
  const cwdUnder = typeof incident.context_cwd_under === "string" && incident.context_cwd_under.trim().length > 0
    ? incident.context_cwd_under
    : undefined;
  const guard = compileGuard(incident, "high");
  return parseGuard({
    ...guard,
    match: {
      ...guard.match,
      command: destructive.matchCommand,
      argsAnyOf: destructive.argsAnyOf,
      ...(cwdUnder ? { context: { cwdUnder } } : {}),
    },
    action: {
      ...guard.action,
      message: cwdUnder
        ? `${incident.recency} live incident: ${incident.condition}. Scoped to this tree — the command runs freely elsewhere.`
        : `${incident.recency} live incident: ${incident.condition}.`,
    },
  });
}

function syntheticCommand(incidentId: string): string {
  if (incidentId === "live-git-clean-untracked") return "git clean -fd";
  if (incidentId === "live-git-stash-untracked") return "git stash -u";
  throw new Error("Live incident command is unsupported.");
}

function assertPlainDirectoryOrMissing(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Live proposal directory is unsafe.");
}

function proposalRoot(home: string): string {
  const path = join(home, "live-proposals");
  assertPlainDirectoryOrMissing(path);
  return path;
}

function proposalDirectory(home: string, incidentId: string): string {
  if (!guardIdPattern.test(incidentId)) throw new Error("Live incident id is invalid.");
  const directory = join(proposalRoot(home), incidentId);
  assertPlainDirectoryOrMissing(directory);
  return directory;
}

function queuePath(home: string, incidentId: string): string {
  if (!guardIdPattern.test(incidentId)) throw new Error("Live incident id is invalid.");
  const directory = join(home, "live-proposal-queue");
  assertPlainDirectoryOrMissing(directory);
  return join(directory, `${incidentId}.json`);
}

function lockDirectory(home: string, incidentId: string): string {
  return join(home, "live-proposal-locks", `${incidentId}.lock`);
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code !== "ESRCH";
  }
}

function acquireProposalLock(home: string, incidentId: string): ProposalLock | undefined {
  const directory = lockDirectory(home, incidentId);
  const root = join(home, "live-proposal-locks");
  assertPlainDirectoryOrMissing(root);
  mkdirSync(root, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = randomUUID();
    try {
      mkdirSync(directory);
      writeFileSync(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token }), "utf8");
      return { directory, token };
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const owner = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8")) as Partial<LockOwner>;
        if (!Number.isInteger(owner.pid) || typeof owner.token !== "string") {
          if (Date.now() - lstatSync(directory).mtimeMs < 5_000) return undefined;
        } else {
          if (processAlive(owner.pid!)) return undefined;
          if (!reclaimProposalLock(directory, owner as LockOwner)) continue;
          continue;
        }
      } catch {
        if (!existsSync(directory)) continue;
        if (Date.now() - lstatSync(directory).mtimeMs < 5_000) return undefined;
      }
      if (!reclaimProposalLock(directory)) continue;
    }
  }
  return undefined;
}

function reclaimProposalLock(directory: string, expected?: LockOwner): boolean {
  const tombstone = `${directory}.${randomUUID()}.reap`;
  try {
    renameSync(directory, tombstone);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
  let reclaim = false;
  try {
    if (!expected) {
      reclaim = true;
    } else {
      const moved = JSON.parse(readFileSync(join(tombstone, "owner.json"), "utf8")) as Partial<LockOwner>;
      reclaim = moved.token === expected.token && moved.pid === expected.pid && !processAlive(expected.pid);
    }
    if (reclaim) return true;
    try {
      renameSync(tombstone, directory);
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
    }
    return false;
  } finally {
    if (reclaim || existsSync(directory)) rmSync(tombstone, { recursive: true, force: true });
  }
}

function releaseProposalLock(lock: ProposalLock): void {
  try {
    const owner = JSON.parse(readFileSync(join(lock.directory, "owner.json"), "utf8")) as { token?: unknown };
    if (owner.token === lock.token) rmSync(lock.directory, { recursive: true, force: true });
  } catch {
    // Another process cannot safely own this token; leave uncertain state for stale recovery.
  }
}

function guardBytes(guard: Guard): string {
  return `${JSON.stringify(guard)}\n`;
}

function guardDigest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function proofBytes(source: string): string {
  const proof: BoundProof = { status: "pass", cases: ["synthetic event fired"], guardSha256: guardDigest(source) };
  return `${JSON.stringify(proof)}\n`;
}

function parseBoundProof(source: string, guardSource: string): BoundProof {
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Live proposal proof is invalid.");
  const proof = value as Partial<BoundProof>;
  if (proof.status !== "pass"
    || !Array.isArray(proof.cases)
    || !proof.cases.every((item) => typeof item === "string")
    || proof.guardSha256 !== guardDigest(guardSource)) {
    throw new Error("Live proposal lacks guard-bound passing proof.");
  }
  return proof as BoundProof;
}

function persistRequest(home: string, incident: IncidentManifest): string {
  compileDetectedGuard(incident);
  const path = queuePath(home, incident.incident_id);
  const lock = acquireProposalLock(home, incident.incident_id);
  if (!lock) {
    if (existsSync(path)) return path;
    throw new Error("Another live compile already owns this incident.");
  }
  try {
    replaceGuardAtomically(path, `${JSON.stringify(incident)}\n`);
    return path;
  } finally {
    releaseProposalLock(lock);
  }
}

export function processQueuedLiveProposal(
  incidentId: string,
  options: LiveProposalOptions = {},
): LiveProposalResult {
  const scope = options.scope ?? "repo";
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = guardHomeForScope(scope, environment, cwd);
  const lock = acquireProposalLock(home, incidentId);
  if (!lock) return { status: "queued", incidentId, warning: "Live compile remains queued locally: another compile owns this incident." };
  try {
    const request = queuePath(home, incidentId);
    if (!existsSync(request)) return { status: "failed", incidentId, warning: "Live compile request is missing." };
    const incident = JSON.parse(readFileSync(request, "utf8")) as IncidentManifest;
    if (incident.incident_id !== incidentId) throw new Error("Live incident queue id does not match request.");
    const guard = compileDetectedGuard(incident);
    const budget = claimCompileBudget(home, "mid-session", options.now);
    if (budget.status === "queued") return { status: "queued", incidentId, warning: budget.warning };
    const proofEvent = { chokepoint: "shell" as const, command: syntheticCommand(incidentId), ...(guard.match.context?.cwdUnder ? { cwd: guard.match.context.cwdUnder } : {}) };
    const verdict = new Runtime().evaluate([guard], proofEvent);
    if (!verdict.fired || !verdict.blocked) return { status: "failed", incidentId, warning: "Synthetic proposal proof did not block." };
    const directory = proposalDirectory(home, incidentId);
    const guardSource = guardBytes(guard);
    const guardPath = join(directory, `${guard.id}.json`);
    applyAtomicFilePlans([
      { path: guardPath, content: guardSource },
      { path: join(directory, "proof.json"), content: proofBytes(guardSource) },
    ]);
    rmSync(request, { force: true });
    return { status: "proposed", incidentId, proposalPath: guardPath };
  } catch (error) {
    return { status: "failed", incidentId, warning: error instanceof Error ? error.message : "Live proposal failed." };
  } finally {
    releaseProposalLock(lock);
  }
}

export function drainQueuedLiveProposalsForScope(
  scope: GuardScope,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  now = new Date(),
): LiveProposalDrainResult {
  const home = guardHomeForScope(scope, environment, cwd);
  const directory = join(home, "live-proposal-queue");
  assertPlainDirectoryOrMissing(directory);
  const result: LiveProposalDrainResult = { proposed: 0, queued: 0, failed: 0 };
  if (!existsSync(directory)) return result;
  const ids = readdirSync(directory).filter((file) => !/^\.[a-f0-9-]{36}\.tmp$/.test(file)).map((file) => {
    const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/.exec(file);
    const path = join(directory, file);
    if (!match || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("Live proposal queue contains an unsafe entry.");
    return match[1];
  }).sort();
  for (const incidentId of ids) {
    const outcome = processQueuedLiveProposal(incidentId, { scope, environment, cwd, now });
    if (outcome.status === "proposed") result.proposed += 1;
    else if (outcome.status === "queued") result.queued += 1;
    else result.failed += 1;
  }
  return result;
}

export function scheduleLiveCompileProposal(
  incident: IncidentManifest,
  options: ScheduleLiveProposalOptions = {},
): ScheduledLiveProposal {
  const scope = options.scope ?? "repo";
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = guardHomeForScope(scope, environment, cwd);
  persistRequest(home, incident);
  const schedule = options.schedule ?? ((task) => setTimeout(task, 0));
  let complete!: (result: LiveProposalResult) => void;
  const completion = new Promise<LiveProposalResult>((resolve) => { complete = resolve; });
  schedule(() => complete(processQueuedLiveProposal(incident.incident_id, { scope, environment, cwd, now: options.now })));
  return { status: "scheduled", incident, completion };
}

export function launchLiveCompileProposal(incident: IncidentManifest, options: LaunchLiveProposalOptions): void {
  const scope = options.scope ?? "repo";
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = guardHomeForScope(scope, environment, cwd);
  const baseCommand = options.cliCommand
    ? [...options.cliCommand]
    : options.cliPath
      ? [process.execPath, options.cliPath]
      : [];
  if (baseCommand.length === 0) throw new Error("Live compiler command is missing.");
  persistRequest(home, incident);
  const command = [...baseCommand, "live-compile-worker", incident.incident_id, scope];
  if (options.launch) {
    options.launch(command, { cwd, env: environment });
    return;
  }
  const child = Bun.spawn(command, { cwd, env: environment, detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  child.unref();
}

export function authorizeHumanLiveCompileApproval(
  incidentId: string,
  reviewedGuardSha256: string,
  signals: RunnerSignals,
): HumanLiveCompileApproval {
  const runner = detectRunnerDetails(signals);
  if (runner.kind !== "human" || runner.source !== "tty") throw new Error("Live guard approval requires a human TTY.");
  if (!/^[a-f0-9]{64}$/.test(reviewedGuardSha256)) throw new Error("Reviewed live guard digest is invalid.");
  return { incidentId, reviewedGuardSha256, [approvalBrand]: true } as HumanLiveCompileApproval;
}

export function reviewLiveCompileProposal(
  incidentId: string,
  options: Omit<LiveProposalOptions, "now"> = {},
): LiveProposalReview {
  const home = guardHomeForScope(options.scope ?? "repo", options.environment ?? process.env, options.cwd ?? process.cwd());
  const directory = proposalDirectory(home, incidentId);
  const proposalPath = join(directory, `${incidentId}.json`);
  const proofPath = join(directory, "proof.json");
  if (!existsSync(proposalPath) || !existsSync(proofPath)) throw new Error("Live compile proposal is incomplete.");
  const guardSource = readFileSync(proposalPath, "utf8");
  const guard = parseGuard(JSON.parse(guardSource));
  if (guard.id !== incidentId) throw new Error("Live proposal id does not match review.");
  const proof = parseBoundProof(readFileSync(proofPath, "utf8"), guardSource);
  return { incidentId, guard, guardSha256: proof.guardSha256 };
}

export function approveLiveCompileProposal(
  approval: HumanLiveCompileApproval,
  options: Omit<LiveProposalOptions, "now"> = {},
): { status: "installed"; path: string } {
  if (!approval || approval[approvalBrand] !== true || !guardIdPattern.test(approval.incidentId)) {
    throw new Error("Explicit human approval is required.");
  }
  const home = guardHomeForScope(options.scope ?? "repo", options.environment ?? process.env, options.cwd ?? process.cwd());
  const lock = acquireProposalLock(home, approval.incidentId);
  if (!lock) throw new Error("Live proposal is still being compiled.");
  try {
    const directory = proposalDirectory(home, approval.incidentId);
    const proposalPath = join(directory, `${approval.incidentId}.json`);
    const proofPath = join(directory, "proof.json");
    if (!existsSync(proposalPath) || !existsSync(proofPath)) throw new Error("Live compile proposal is incomplete.");
    for (const path of [proposalPath, proofPath]) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Live compile proposal is unsafe.");
    }
    const guardSource = readFileSync(proposalPath, "utf8");
    const guard = parseGuard(JSON.parse(guardSource));
    if (guard.id !== approval.incidentId) throw new Error("Live proposal id does not match approval.");
    const proof = parseBoundProof(readFileSync(proofPath, "utf8"), guardSource);
    if (proof.guardSha256 !== approval.reviewedGuardSha256) throw new Error("Live proposal changed after human review.");
    const guardsDirectory = join(home, "guards");
    const installedPath = join(guardsDirectory, `${guard.id}.json`);
    if (existsSync(installedPath)) throw new Error("Installed guard already exists.");
    applyAtomicFilePlans([
      { path: installedPath, content: guardSource },
      { path: join(guardsDirectory, "proof.json"), content: proofBytes(guardSource) },
    ]);
    return { status: "installed", path: installedPath };
  } finally {
    releaseProposalLock(lock);
  }
}
