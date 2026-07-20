import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const cli = (input: string): { stdout: string; stderr: string; status: number } => {
  const result = spawnSync("bun", ["src/cli.ts", "scrub", "gitleaks", "--json"], {
    cwd: import.meta.dir + "/..",
    input,
    encoding: "utf8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status ?? -1 };
};

test("scrub gitleaks strips AWS access keys the old pattern list missed", () => {
  const { stdout, status } = cli(JSON.stringify({ payload: "deploy --key AKIAIOSFODNN7EXAMPLE done" }));
  expect(status).toBe(0);
  const parsed = JSON.parse(stdout) as { payload: string; findings: Array<{ name: string; count: number }> };
  expect(parsed.payload).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(parsed.findings.some((f) => f.name === "aws_key")).toBe(true);
});

test("scrub gitleaks strips GitHub personal access tokens the old pattern list missed", () => {
  const { stdout, status } = cli(JSON.stringify({ payload: "token ghp_16C7e42F292c6912E7710c838347Ae178B4a end" }));
  expect(status).toBe(0);
  const parsed = JSON.parse(stdout) as { payload: string; findings: Array<{ name: string; count: number }> };
  expect(parsed.payload).not.toContain("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
  expect(parsed.findings.some((f) => f.name === "github_pat")).toBe(true);
});

test("scrub gitleaks redacts session-id UUIDs", () => {
  const { stdout, status } = cli(JSON.stringify({ payload: "session 077094bd-f4e9-4f96-abb3-dc79eeddf21a ok" }));
  expect(status).toBe(0);
  const parsed = JSON.parse(stdout) as { payload: string; findings: Array<{ name: string; count: number }> };
  expect(parsed.payload).not.toContain("077094bd-f4e9-4f96-abb3-dc79eeddf21a");
  expect(parsed.findings.some((f) => f.name === "session_id")).toBe(true);
});
