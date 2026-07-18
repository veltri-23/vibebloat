import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(consent = false) {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-returning-"));
  roots.push(root);
  const repository = join(root, "repo");
  const home = join(root, "state");
  mkdirSync(repository, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({
    gate: "END",
    scope: "repo",
    answers: consent ? { F1b: "Sure" } : {},
  }));
  const environment = {
    ...process.env,
    USERPROFILE: root,
    HOME: root,
    VIBEBLOAT_HOME: home,
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CODEX_HOME: join(root, "codex"),
    HERMES_HOME: join(root, "hermes"),
    OPENCLAW_SESSION: "",
  };
  return { root, repository, home, environment };
}

function invoke(value: ReturnType<typeof fixture>, ...args: string[]) {
  return Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    cwd: value.repository,
    env: value.environment,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("completed onboarding opens the returning menu on a bare rerun", () => {
  const value = fixture();
  const result = invoke(value);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    gate: "R0",
    prompt: {
      question: expect.stringContaining("Welcome back"),
      options: ["Something broke or a new problem", "A new project or tool", "Clean up or change my rules", "Just checking in / catch me up"],
    },
  });
});

test("returning manage runs real rule evidence and stores only consented fixed reason", () => {
  const value = fixture(true);
  const result = invoke(value, "onboard", "--again", "--answer", "Clean up or change my rules");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    gate: "R3",
    result: { kind: "manage-rules", rules: expect.any(Array), mostOverridden: null },
  });
  expect(JSON.parse(readFileSync(join(value.home, "onboarding.json"), "utf8"))).toMatchObject({
    returningConversations: [{ reason: "manage" }],
  });
});

test("returning freeform help stays on the locked menu", () => {
  const value = fixture();
  const result = invoke(value, "onboard", "--again", "--answer", "what should I choose?");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    gate: "R0",
    prompt: { question: expect.stringContaining("Welcome back") },
    assist: { answer: expect.any(String), question: expect.stringContaining("Welcome back") },
  });
});

test("returning catch-up reports its incremental cursor blocker", () => {
  const value = fixture();
  const result = invoke(value, "onboard", "--again", "--answer", "Just checking in / catch me up");
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    gate: "R4",
    result: {
      kind: "catch-up",
      complete: false,
      incrementalScan: { status: "blocked", reason: "No durable returning-scan cursor exists." },
    },
  });
});

test("returning problem scan fails closed without a durable cursor", () => {
  const value = fixture();
  const result = invoke(value, "onboard", "--again", "--answer", "Something broke or a new problem");
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(
    "WHAT failed: returning action stopped.\n" +
    "WHY: since-last-run problem scan is unavailable because no durable returning-scan cursor exists.\n" +
    "FIX: vibebloat doctor\n",
  );
});
