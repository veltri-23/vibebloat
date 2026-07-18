import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimCompileBudget } from "../src/compiler/budget";
import { detectLiveGitIncident, scheduleLiveCompileProposal } from "../src/compiler/live-incident";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("compile --drain turns a durable budget overflow into a reviewable proposal", async () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-live-drain-"));
  temporaryDirectories.push(project);
  const home = join(project, ".vibebloat");
  mkdirSync(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "J1", answers: {}, scope: "repo" }));
  const oldDay = new Date("2000-01-01T12:00:00.000Z");
  for (let count = 0; count < 5; count += 1) expect(claimCompileBudget(home, "mid-session", oldDay).status).toBe("allowed");
  const incident = detectLiveGitIncident({
    command: "git clean -fd",
    exitCode: 0,
    before: { untrackedPaths: ["launch.cmd"] },
    after: { untrackedPaths: [] },
    occurredAt: oldDay,
  })!;
  let task!: () => void;
  const scheduled = scheduleLiveCompileProposal(incident, { cwd: project, now: oldDay, schedule: (next) => { task = next; } });
  task();
  expect((await scheduled.completion).status).toBe("queued");

  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "compile", "--drain"], {
    cwd: project,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    status: "drained",
    scope: "repo",
    live_proposals: { proposed: 1, queued: 0, failed: 0 },
  });
  expect(existsSync(join(home, "live-proposals", "live-git-clean-untracked", "live-git-clean-untracked.json"))).toBeTrue();
  expect(existsSync(join(home, "guards", "live-git-clean-untracked.json"))).toBeFalse();
});

test("compile --drain ignores owned atomic temps but sanitizes unsafe queue entries", () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-live-unsafe-"));
  temporaryDirectories.push(project);
  const home = join(project, ".vibebloat");
  const queue = join(home, "live-proposal-queue");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "J1", answers: {}, scope: "repo" }));
  writeFileSync(join(queue, ".12345678-1234-1234-1234-123456789abc.tmp"), "in progress");
  const command = ["bun", join(import.meta.dir, "..", "src", "cli.ts"), "compile", "--drain"];
  expect(Bun.spawnSync(command, { cwd: project, env: process.env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);

  writeFileSync(join(queue, "unsafe.txt"), "unsafe");
  const rejected = Bun.spawnSync(command, { cwd: project, env: process.env, stdout: "pipe", stderr: "pipe" });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stdout.toString()).toBe("");
  expect(rejected.stderr.toString()).toBe("WHAT failed: compile queue drain stopped.\nWHY: queued compile storage contains an unsafe or unreadable entry.\nFIX: vibebloat doctor\n");
  expect(rejected.stderr.toString()).not.toContain(project);
  expect(rejected.stderr.toString()).not.toContain("live-incident.ts");
});
