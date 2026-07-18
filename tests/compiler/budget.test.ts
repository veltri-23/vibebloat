import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claimCompileBudget, drainQueuedCompileJobs, enqueueCompileJob, queuedCompileJobs } from "../../src/compiler/budget";
import { compileLiveForScope, drainQueuedLiveCompilesForScope } from "../../src/compiler/live-compile";
import { gitStashUntrackedGuard } from "../../src/guards";

const temporaryDirectories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-budget-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("allows five mid-session compiles then queues without changing the guard directory", () => {
  const home = directory();
  const now = new Date("2026-07-18T12:00:00.000Z");

  for (let index = 0; index < 5; index += 1) {
    expect(claimCompileBudget(home, "mid-session", now)).toEqual({ status: "allowed" });
  }
  expect(claimCompileBudget(home, "mid-session", now)).toMatchObject({ status: "queued", warning: expect.stringContaining("daily budget is exhausted") });
  expect(JSON.parse(readFileSync(join(home, "compile-budget.json"), "utf8"))).toEqual({ day: "2026-07-18", midSession: 5, sessionEnd: 0 });
});

test("allows fifty session-end compiles independently", () => {
  const home = directory();
  const now = new Date("2026-07-18T12:00:00.000Z");

  for (let index = 0; index < 50; index += 1) {
    expect(claimCompileBudget(home, "session-end", now)).toEqual({ status: "allowed" });
  }
  expect(claimCompileBudget(home, "session-end", now)).toMatchObject({ status: "queued", warning: expect.stringContaining("daily budget is exhausted") });
});

test("UTC rollover resets the durable budget", () => {
  const home = directory();
  const lastMinute = new Date("2026-07-18T23:59:59.000Z");
  const nextMinute = new Date("2026-07-19T00:00:00.000Z");

  for (let index = 0; index < 5; index += 1) claimCompileBudget(home, "mid-session", lastMinute);
  expect(claimCompileBudget(home, "mid-session", lastMinute).status).toBe("queued");
  expect(claimCompileBudget(home, "mid-session", nextMinute)).toEqual({ status: "allowed" });
  expect(JSON.parse(readFileSync(join(home, "compile-budget.json"), "utf8"))).toEqual({ day: "2026-07-19", midSession: 1, sessionEnd: 0 });
});

test("a fresh lock queues a durable compile job without writing a guard", () => {
  const root = directory();
  const project = join(root, "project");
  const home = join(project, ".vibebloat");
  const environment = { USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv;
  const now = new Date("2026-07-18T12:00:00.000Z");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "compile-budget.lock"), "held");

  const result = compileLiveForScope(
    "repo",
    gitStashUntrackedGuard,
    { chokepoint: "shell", command: "git stash -u" },
    environment,
    project,
    { trigger: "mid-session", now },
  );

  expect(result).toMatchObject({ status: "queued", queueId: expect.any(String), warning: expect.stringContaining("another compile claim") });
  expect(queuedCompileJobs(home)).toMatchObject([{ id: result.queueId, guard: { id: gitStashUntrackedGuard.id }, event: { command: "git stash -u" }, trigger: "mid-session" }]);
  expect(existsSync(join(home, "guards", "git-stash-u.json"))).toBeFalse();
});

test("a stale compile lock is reclaimed instead of permanently queueing work", () => {
  const home = directory();
  const lock = join(home, "compile-budget.lock");
  writeFileSync(lock, JSON.stringify({ pid: 999_999_999, token: "stale-owner" }));

  expect(claimCompileBudget(home, "mid-session", new Date("2026-07-18T12:00:00.000Z"))).toEqual({ status: "allowed" });
  expect(existsSync(lock)).toBeFalse();
  expect(existsSync(join(home, "compile-budget.json"))).toBeTrue();
});

test("an incomplete lock candidate never blocks a compile claim", () => {
  const home = directory();
  writeFileSync(join(home, ".compile-budget.999999999.deadbeef.candidate"), "");

  expect(claimCompileBudget(home, "mid-session", new Date("2026-07-18T12:00:00.000Z"))).toEqual({ status: "allowed" });
});

test("a live lock owner is never reclaimed during a long pause", () => {
  const home = directory();
  const lock = join(home, "compile-budget.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "live-owner" }));

  expect(claimCompileBudget(home, "mid-session")).toMatchObject({ status: "queued", warning: expect.stringContaining("another compile claim") });
  expect(existsSync(lock)).toBeTrue();
});

test("cross-process claims never exceed the mid-session limit", async () => {
  const home = directory();
  const moduleUrl = pathToFileURL(join(import.meta.dir, "../../src/compiler/budget.ts")).href;
  const script = `import { claimCompileBudget } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(claimCompileBudget(${JSON.stringify(home)}, "mid-session", new Date("2026-07-18T12:00:00.000Z"))));`;
  const workers = Array.from({ length: 12 }, () => Bun.spawn({
    cmd: [process.execPath, "-e", script],
    stdout: "pipe",
    stderr: "pipe",
  }));
  const results = await Promise.all(workers.map(async (worker) => {
    expect(await worker.exited).toBe(0);
    return JSON.parse(await new Response(worker.stdout).text()) as { status: "allowed" | "queued" };
  }));
  const allowed = results.filter((result) => result.status === "allowed");

  expect(allowed.length).toBeGreaterThan(0);
  expect(allowed.length).toBeLessThanOrEqual(5);
  expect(JSON.parse(readFileSync(join(home, "compile-budget.json"), "utf8"))).toEqual({ day: "2026-07-18", midSession: allowed.length, sessionEnd: 0 });
});

test("scoped live compilation claims before writing a guard", () => {
  const root = directory();
  const project = join(root, "project");
  const environment = { USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv;
  const now = new Date("2026-07-18T12:00:00.000Z");

  for (let index = 0; index < 5; index += 1) claimCompileBudget(join(project, ".vibebloat"), "mid-session", now);
  const result = compileLiveForScope(
    "repo",
    gitStashUntrackedGuard,
    { chokepoint: "shell", command: "git stash -u" },
    environment,
    project,
    { trigger: "mid-session", now },
  );

  expect(result).toMatchObject({ status: "queued", warning: expect.stringContaining("daily budget is exhausted") });
  expect(existsSync(join(project, ".vibebloat", "guards", "git-stash-u.json"))).toBeFalse();
});

test("over-budget work persists until a later UTC-day drain writes its guard", () => {
  const root = directory();
  const project = join(root, "project");
  const home = join(project, ".vibebloat");
  const environment = { USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv;
  const dayOne = new Date("2026-07-18T12:00:00.000Z");
  const dayTwo = new Date("2026-07-19T00:00:00.000Z");

  for (let index = 0; index < 5; index += 1) claimCompileBudget(home, "mid-session", dayOne);
  const queued = compileLiveForScope(
    "repo",
    gitStashUntrackedGuard,
    { chokepoint: "shell", command: "git stash -u" },
    environment,
    project,
    { trigger: "mid-session", now: dayOne },
  );
  expect(queued.status).toBe("queued");
  expect(queuedCompileJobs(home)).toHaveLength(1);

  expect(drainQueuedLiveCompilesForScope("repo", environment, project, dayOne)).toEqual({ completed: 0, queued: 1, failed: 0 });
  expect(queuedCompileJobs(home)).toHaveLength(1);
  expect(existsSync(join(home, "guards", "git-stash-u.json"))).toBeFalse();

  expect(drainQueuedLiveCompilesForScope("repo", environment, project, dayTwo)).toEqual({ completed: 1, queued: 0, failed: 0 });
  expect(queuedCompileJobs(home)).toEqual([]);
  expect(existsSync(join(home, "guards", "git-stash-u.json"))).toBeTrue();
});

test("failed queued work is retained until a guard write succeeds", () => {
  const home = directory();
  enqueueCompileJob(home, {
    guard: gitStashUntrackedGuard,
    event: { chokepoint: "shell", command: "git status" },
    trigger: "mid-session",
  }, new Date("2026-07-18T12:00:00.000Z"));

  expect(drainQueuedCompileJobs(home, (job) => {
    const result = compileLiveForScope(
      "repo",
      job.guard,
      job.event,
      { USERPROFILE: home } as NodeJS.ProcessEnv,
      home,
      { trigger: job.trigger, now: new Date("2026-07-19T00:00:00.000Z") },
    );
    return result.status === "pass" ? "completed" : "failed";
  })).toEqual({ completed: 0, queued: 0, failed: 1 });
  expect(queuedCompileJobs(home)).toHaveLength(1);
  expect(existsSync(join(home, "guards", "git-stash-u.json"))).toBeFalse();
});

test("an active drain cannot be reclaimed while its owning process is alive", () => {
  const home = directory();
  const job = enqueueCompileJob(home, {
    guard: gitStashUntrackedGuard,
    event: { chokepoint: "shell", command: "git stash -u" },
    trigger: "mid-session",
  });
  expect(drainQueuedCompileJobs(home, () => {
    expect(drainQueuedCompileJobs(home, () => "completed")).toEqual({ completed: 0, queued: 0, failed: 0 });
    return "failed";
  })).toEqual({ completed: 0, queued: 0, failed: 1 });
  expect(queuedCompileJobs(home)).toHaveLength(1);
});

test("a stale processing lease is recovered after an interrupted drain", () => {
  const home = directory();
  const job = enqueueCompileJob(home, {
    guard: gitStashUntrackedGuard,
    event: { chokepoint: "shell", command: "git stash -u" },
    trigger: "mid-session",
  });
  const queuedPath = join(home, "compile-queue", `${job.id}.json`);
  const processingPath = queuedPath.replace(/\.json$/, ".999999999.deadbeef.processing");
  renameSync(queuedPath, processingPath);

  expect(drainQueuedCompileJobs(home, () => "completed")).toEqual({ completed: 1, queued: 0, failed: 0 });
  expect(queuedCompileJobs(home)).toEqual([]);
});

test("corrupt budget state fails closed and retains a durable queued job", () => {
  const root = directory();
  const project = join(root, "project");
  const home = join(project, ".vibebloat");
  const environment = { USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv;
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "compile-budget.json"), "not json");

  const result = compileLiveForScope(
    "repo",
    gitStashUntrackedGuard,
    { chokepoint: "shell", command: "git stash -u" },
    environment,
    project,
    { trigger: "mid-session", now: new Date("2026-07-18T12:00:00.000Z") },
  );

  expect(result).toMatchObject({ status: "queued", warning: expect.stringContaining("budget state is unavailable") });
  expect(queuedCompileJobs(home)).toHaveLength(1);
  expect(existsSync(join(home, "guards", "git-stash-u.json"))).toBeFalse();
});
