import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const repository = join(import.meta.dir, "..");
const agentEnvironment = ["CLAUDE_CODE_ENTRYPOINT", "CODEX_HOME", "OPENCLAW_SESSION", "HERMES_HOME"] as const;

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function cleanEnvironment(home: string, values: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    ...Object.fromEntries(agentEnvironment.map((name) => [name, ""])),
    VIBEBLOAT_HOME: home,
    ...values,
  } as Record<string, string>;
}

function init(home: string, args: string[] = [], values: Record<string, string> = {}) {
  return Bun.spawnSync(["bun", "src/cli.ts", "init", ...args], {
    cwd: repository,
    env: cleanEnvironment(home, values),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readOutput(result: ReturnType<typeof init>) {
  expect(result.exitCode).toBe(0);
  return JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, unknown>;
}

test("init surfaces non-interactive TTY and agent-environment detection without changing prompts", () => {
  const ttyHome = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-runner-"));
  const environmentHome = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-runner-"));
  temporaryDirectories.push(ttyHome, environmentHome);

  expect(readOutput(init(ttyHome))).toMatchObject({
    gate: "A0", runner: "agent", runnerSource: "non-interactive",
    prompt: { question: expect.stringContaining("VibeBloat") },
  });
  // A0 now persists the empty state on display (audit finding L11).
  expect(existsSync(join(ttyHome, "onboarding.json"))).toBeTrue();

  expect(readOutput(init(environmentHome, ["--answer", "Yes"], { OPENCLAW_SESSION: "session" }))).toMatchObject({
    gate: "A1", runner: "agent", runnerSource: "environment",
  });
  expect(JSON.parse(readFileSync(join(environmentHome, "onboarding.json"), "utf8"))).toMatchObject({ runner: "agent" });
});

test("init recognizes a real agent-named parent process", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-runner-"));
  temporaryDirectories.push(home);
  const parent = join(home, "codex-parent.ts");
  writeFileSync(parent, [
    'const result = Bun.spawnSync([process.execPath, process.argv[2]!, "init"], { cwd: process.argv[3]!, env: JSON.parse(process.argv[4]!), stdin: "pipe", stdout: "pipe", stderr: "pipe" });',
    'process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.exitCode);',
  ].join("\n"));

  const result = Bun.spawnSync(["bun", parent, join(repository, "src", "cli.ts"), repository, JSON.stringify(cleanEnvironment(home))], {
    cwd: repository, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  expect(readOutput(result as ReturnType<typeof init>)).toMatchObject({ runner: "agent", runnerSource: "parent-process" });
});

test("init flags override detected and saved runner modes", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-runner-"));
  temporaryDirectories.push(home);

  expect(readOutput(init(home, ["--human", "--answer", "Yes"], { CODEX_HOME: "agent" }))).toMatchObject({ runner: "human", runnerSource: "explicit" });
  expect(JSON.parse(readFileSync(join(home, "onboarding.json"), "utf8"))).toMatchObject({ runner: "human" });
  expect(readOutput(init(home, ["--agent"]))).toMatchObject({ runner: "agent", runnerSource: "explicit" });

  const invalid = init(home, ["--agent", "--human"]);
  expect(invalid.exitCode).toBe(1);
  expect(new TextDecoder().decode(invalid.stderr)).toBe("WHAT failed: onboarding runner selection stopped.\nWHY: choose either --agent or --human, not both.\nFIX: vibebloat init --human\n");
});

test("init ignores an invalid saved runner mode and redetects safely", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-runner-"));
  temporaryDirectories.push(home);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "A0", answers: {}, runner: "invalid" }));

  expect(readOutput(init(home))).toMatchObject({ runner: "agent", runnerSource: "non-interactive" });
});
