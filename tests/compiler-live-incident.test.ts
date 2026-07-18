import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "../src/runtime";
import { loadGuards } from "../src/guard-loader";
import {
  approveLiveCompileProposal,
  authorizeHumanLiveCompileApproval,
  detectLiveGitIncident,
  drainQueuedLiveProposalsForScope,
  launchLiveCompileProposal,
  reviewLiveCompileProposal,
  scheduleLiveCompileProposal,
  type GitTreeSnapshot,
} from "../src/compiler/live-incident";
import { claimCompileBudget } from "../src/compiler/budget";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const before: GitTreeSnapshot = { untrackedPaths: ["launch.cmd", "ops/start.ps1"] };
const after: GitTreeSnapshot = { untrackedPaths: [] };

function incident() {
  const detected = detectLiveGitIncident({
    command: "git clean -fd",
    exitCode: 0,
    before,
    after,
    occurredAt: new Date("2026-07-18T12:00:00.000Z"),
  });
  expect(detected).toBeDefined();
  return detected!;
}

test("live detector requires a successful destructive Git command and a real tree delta", () => {
  expect(detectLiveGitIncident({ command: "git clean -fd", exitCode: 1, before, after, occurredAt: new Date() })).toBeUndefined();
  expect(detectLiveGitIncident({ command: "git clean -n", exitCode: 0, before, after, occurredAt: new Date() })).toBeUndefined();
  expect(detectLiveGitIncident({ command: "git clean -fd -- launch.cmd", exitCode: 0, before, after, occurredAt: new Date() })).toBeUndefined();
  expect(detectLiveGitIncident({ command: "git clean -fd", exitCode: 0, before, after: before, occurredAt: new Date() })).toBeUndefined();
});

test("live compile stays off-path and stages a proven proposal without installing it", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-incident-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  let task: (() => void) | undefined;
  const scheduled = scheduleLiveCompileProposal(incident(), {
    cwd: project,
    now: new Date("2026-07-18T12:00:00.000Z"),
    schedule: (next) => { task = next; },
  });
  const proposal = join(project, ".vibebloat", "live-proposals", "live-git-clean-untracked", "live-git-clean-untracked.json");
  const installed = join(project, ".vibebloat", "guards", "live-git-clean-untracked.json");

  expect(scheduled.status).toBe("scheduled");
  expect(task).toBeFunction();
  expect(existsSync(proposal)).toBeFalse();
  expect(existsSync(installed)).toBeFalse();

  task!();
  expect(await scheduled.completion).toMatchObject({ status: "proposed", incidentId: "live-git-clean-untracked" });
  expect(existsSync(proposal)).toBeTrue();
  expect(existsSync(installed)).toBeFalse();
  expect(readFileSync(proposal, "utf8")).not.toContain("launch.cmd");
  expect(readFileSync(proposal, "utf8")).not.toContain("ops/start.ps1");
});

test("shell launcher persists work and returns without running the compiler", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-launch-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  let launched: readonly string[] | undefined;
  launchLiveCompileProposal(incident(), {
    cwd: project,
    cliPath: join(project, "cli.ts"),
    launch: (command) => { launched = command; },
  });

  expect(launched).toEqual([process.execPath, join(project, "cli.ts"), "live-compile-worker", "live-git-clean-untracked", "repo"]);
  expect(existsSync(join(project, ".vibebloat", "live-proposal-queue", "live-git-clean-untracked.json"))).toBeTrue();
  expect(existsSync(join(project, ".vibebloat", "live-proposals"))).toBeFalse();
});

test("forged live incident content fails before budget or proposal writes", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-forged-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const forged = { ...incident(), condition: "Bearer secret-value" };
  expect(() => scheduleLiveCompileProposal(forged, {
    cwd: project,
    now: new Date("2026-07-18T12:00:00.000Z"),
  })).toThrow("invalid");

  expect(existsSync(join(project, ".vibebloat", "compile-budget.json"))).toBeFalse();
  expect(existsSync(join(project, ".vibebloat", "live-proposals"))).toBeFalse();
});

test("over-budget and active-writer work remains durably queued", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-queued-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const home = join(project, ".vibebloat");
  const now = new Date("2026-07-18T12:00:00.000Z");
  for (let count = 0; count < 5; count += 1) expect(claimCompileBudget(home, "mid-session", now).status).toBe("allowed");
  let task!: () => void;
  const scheduled = scheduleLiveCompileProposal(incident(), { cwd: project, now, schedule: (next) => { task = next; } });
  task();
  expect(await scheduled.completion).toMatchObject({ status: "queued", warning: expect.stringContaining("budget") });
  const request = join(home, "live-proposal-queue", "live-git-clean-untracked.json");
  expect(existsSync(request)).toBeTrue();

  expect(drainQueuedLiveProposalsForScope("repo", process.env, project, new Date("2026-07-19T12:00:00.000Z"))).toEqual({ proposed: 1, queued: 0, failed: 0 });
  expect(existsSync(request)).toBeFalse();
  const queuedAgain = scheduleLiveCompileProposal(incident(), { cwd: project, now, schedule: () => {} });
  expect(queuedAgain.status).toBe("scheduled");
  expect(existsSync(request)).toBeTrue();

  rmSync(join(home, "compile-budget.json"), { force: true });
  const lock = join(home, "live-proposal-locks", "live-git-clean-untracked.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token: "active" }));
  let lockedTask!: () => void;
  const locked = scheduleLiveCompileProposal(incident(), { cwd: project, now, schedule: (next) => { lockedTask = next; } });
  lockedTask();
  expect(await locked.completion).toMatchObject({ status: "queued", warning: expect.stringContaining("another compile") });
  expect(existsSync(request)).toBeTrue();
});

test("only explicit human approval atomically installs the proven proposal", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-approval-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const scheduled = scheduleLiveCompileProposal(incident(), {
    cwd: project,
    now: new Date("2026-07-18T12:00:00.000Z"),
  });
  expect((await scheduled.completion).status).toBe("proposed");
  const guardsDirectory = join(project, ".vibebloat", "guards");
  expect(loadGuards(guardsDirectory)).toHaveLength(0);

  const review = reviewLiveCompileProposal("live-git-clean-untracked", { cwd: project });
  expect(() => authorizeHumanLiveCompileApproval("live-git-clean-untracked", review.guardSha256, {
    isTTY: false,
    env: {},
    parentProcess: "bun test",
  })).toThrow("human TTY");
  const approval = authorizeHumanLiveCompileApproval("live-git-clean-untracked", review.guardSha256, {
    isTTY: true,
    env: {},
    parentProcess: "powershell",
  });
  const installed = approveLiveCompileProposal(approval, { cwd: project });

  expect(installed.status).toBe("installed");
  const guards = loadGuards(guardsDirectory);
  expect(guards).toHaveLength(1);
  expect(new Runtime().evaluate(guards, { chokepoint: "shell", command: "git clean -n" }).fired).toBeFalse();
  expect(new Runtime().evaluate(guards, { chokepoint: "shell", command: "git clean -fd" })).toMatchObject({
    fired: true,
    blocked: true,
    guardId: "live-git-clean-untracked",
    receipt: expect.stringContaining("2026-07-18"),
  });
});

test("review digest rejects a recomputed proof after proposal tampering", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-tamper-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");
  const scheduled = scheduleLiveCompileProposal(incident(), { cwd: project, now: new Date("2026-07-18T12:00:00.000Z") });
  expect((await scheduled.completion).status).toBe("proposed");
  const proposal = join(project, ".vibebloat", "live-proposals", "live-git-clean-untracked", "live-git-clean-untracked.json");
  const proofPath = join(project, ".vibebloat", "live-proposals", "live-git-clean-untracked", "proof.json");
  const review = reviewLiveCompileProposal("live-git-clean-untracked", { cwd: project });
  const value = JSON.parse(readFileSync(proposal, "utf8"));
  value.action.message = "tampered";
  const tamperedSource = `${JSON.stringify(value)}\n`;
  writeFileSync(proposal, tamperedSource);
  writeFileSync(proofPath, JSON.stringify({ status: "pass", cases: ["synthetic event fired"], guardSha256: createHash("sha256").update(tamperedSource).digest("hex") }));
  const approval = authorizeHumanLiveCompileApproval("live-git-clean-untracked", review.guardSha256, { isTTY: true, env: {}, parentProcess: "powershell" });

  expect(() => approveLiveCompileProposal(approval, { cwd: project })).toThrow("changed after human review");
  expect(existsSync(join(project, ".vibebloat", "guards", "live-git-clean-untracked.json"))).toBeFalse();
});
