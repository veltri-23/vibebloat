import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const PROJECT_DIR = join(import.meta.dir, "..");
const CLI = ["bun", join(PROJECT_DIR, "src/cli.ts")];

function runCli(home: string, env: NodeJS.ProcessEnv, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(CLI[0]!, [...CLI.slice(1), ...args], {
    cwd: PROJECT_DIR,
    env: { ...process.env, ...env, VIBEBLOAT_HOME: home },
    encoding: "utf8",
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("B1.missing lets the user back out with 'Actually that is everything'", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vb-b1missing-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "B1.missing", answers: { B1: "You missed one" } }));

  const result = runCli(home, {}, ["init", "--answer", "Actually that is everything"]);

  if (result.status !== 0) {
    console.error("STDERR:", result.stderr);
    console.error("STDOUT:", result.stdout);
  }
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout) as { gate: string; answers?: Record<string, string> };
  expect(parsed.gate).toBe("B1");
});

test("B1.missing also accepts 'never mind' as a back-out", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vb-b1missing-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "B1.missing", answers: { B1: "You missed one" } }));

  const result = runCli(home, {}, ["init", "--answer", "never mind"]);

  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout) as { gate: string };
  expect(parsed.gate).toBe("B1");
});
