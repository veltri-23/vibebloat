import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { claimCompileBudget } from "../../src/compiler/budget";
import { compileLiveForScope } from "../../src/compiler/live-compile";
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

test("a concurrent claim is queued and cannot exceed the daily budget", () => {
  const home = directory();
  writeFileSync(join(home, "compile-budget.lock"), "held");

  expect(claimCompileBudget(home, "mid-session")).toMatchObject({ status: "queued", warning: expect.stringContaining("another compile claim") });
  expect(existsSync(join(home, "compile-budget.json"))).toBeFalse();
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
