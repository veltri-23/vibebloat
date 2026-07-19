import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileGuard } from "../src/compiler/codex-fill";

const temporaryDirectories: string[] = [];
const root = join(import.meta.dir, "..");

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function compile(project: string, incidentPath?: string, environment: Record<string, string> = {}) {
  const { VIBEBLOAT_HOME: _ignored, ...parentEnvironment } = process.env;
  return Bun.spawnSync(["bun", join(root, "src", "cli.ts"), "compile", ...(incidentPath ? [incidentPath] : [])], {
    cwd: project,
    env: { ...parentEnvironment, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function drain(project: string, environment: Record<string, string> = {}) {
  const { VIBEBLOAT_HOME: _ignored, ...parentEnvironment } = process.env;
  return Bun.spawnSync(["bun", join(root, "src", "cli.ts"), "compile", "--drain"], {
    cwd: project,
    env: { ...parentEnvironment, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function hook(project: string, command: string, environment: Record<string, string> = {}) {
  const { VIBEBLOAT_HOME: _ignored, ...parentEnvironment } = process.env;
  return Bun.spawnSync(["bun", join(root, "src", "cli.ts"), "hook"], {
    cwd: project,
    env: { ...parentEnvironment, USERPROFILE: join(project, "user"), HOME: join(project, "user"), ...environment },
    stdin: new Blob([JSON.stringify({ tool_input: { command } })]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeOnboardingScope(project: string, scope: "repo" | "machine"): void {
  const home = join(project, ".vibebloat");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate: "J1", answers: {}, scope }));
}

function writeIncident(project: string, incident: Record<string, unknown>, name = "incident.json"): string {
  const path = join(project, name);
  writeFileSync(path, JSON.stringify(incident));
  return path;
}

const incident = {
  incident_id: "incident-stash-u",
  class: "A",
  chokepoint: "shell",
  command: "git stash -u",
  condition: "untracked files present",
  evidence_refs: ["claude-code:one:2:0"],
  severity: 5,
  frequency: 2,
  recency: "2026-07-17",
};

test("compile proves one incident and writes it to the selected repo guard home", () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-compile-"));
  temporaryDirectories.push(project);
  writeOnboardingScope(project, "repo");
  const incidentPath = writeIncident(project, incident);
  const guardPath = join(project, ".vibebloat", "guards", "incident-stash-u.json");

  const result = compile(project, incidentPath);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    status: "pass",
    scope: "repo",
    path: guardPath,
    proof_path: join(project, ".vibebloat", "guards", "proof.json"),
  });
  expect(JSON.parse(readFileSync(guardPath, "utf8"))).toMatchObject({ id: "incident-stash-u", action: { type: "block" } });
  expect(JSON.parse(readFileSync(join(project, ".vibebloat", "guards", "proof.json"), "utf8"))).toEqual({ status: "pass", cases: ["synthetic event fired"] });
});

test("compile honors the selected machine guard home", () => {
  const rootDirectory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-compile-"));
  temporaryDirectories.push(rootDirectory);
  const project = join(rootDirectory, "project");
  mkdirSync(project);
  writeOnboardingScope(project, "machine");
  const incidentPath = writeIncident(project, { ...incident, incident_id: "machine-stash" });
  const userHome = join(rootDirectory, "user");
  const guardPath = join(userHome, ".vibebloat", "guards", "machine-stash.json");

  const result = compile(project, incidentPath, { USERPROFILE: userHome, HOME: userHome });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ status: "pass", scope: "machine", path: guardPath });
  expect(existsSync(guardPath)).toBeTrue();
});

test("compile rejects a non-matchable manifest without writing a guard", () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-compile-"));
  temporaryDirectories.push(project);
  writeOnboardingScope(project, "repo");
  const incidentPath = writeIncident(project, { ...incident, command: "" });

  const result = compile(project, incidentPath);

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("WHAT failed: guard compilation stopped.\nWHY: incident file must contain one safe, matchable incident manifest\nFIX: correct <incident.json>, then run vibebloat compile <incident.json>\n");
  expect(existsSync(join(project, ".vibebloat", "guards", "incident-stash-u.json"))).toBeFalse();
});

test("compile receipt stays outside the runtime guard set", () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-compile-"));
  temporaryDirectories.push(project);
  writeOnboardingScope(project, "repo");
  const incidentPath = writeIncident(project, { ...incident, incident_id: "no-publish", command: "npm publish" });

  expect(compile(project, incidentPath).exitCode).toBe(0);
  const result = hook(project, "npm publish");

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe([
    "BLOCKED  guard: no-publish  class: A",
    "incident: untracked files present  date: 2026-07-17",
    "why: 07-17 untracked files present.",
    "fix: vibebloat allow no-publish --once",
    "",
  ].join("\n"));
});

test("compile --drain executes a persisted local compile job", () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-compile-"));
  temporaryDirectories.push(project);
  writeOnboardingScope(project, "repo");
  const queue = join(project, ".vibebloat", "compile-queue");
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, "queued-job.json"), JSON.stringify({
    id: "queued-job",
    queuedAt: "2026-07-18T12:00:00.000Z",
    trigger: "session-end",
    guard: compileGuard({ ...incident, incident_id: "queued-stash" }, "high"),
    event: { chokepoint: "shell", command: "git stash -u" },
  }));

  const result = drain(project);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ status: "drained", scope: "repo", completed: 1, queued: 0, failed: 0 });
  expect(existsSync(join(project, ".vibebloat", "guards", "queued-stash.json"))).toBeTrue();
  expect(existsSync(join(queue, "queued-job.json"))).toBeFalse();
});

test("compile rejects unsafe and reserved ids before any guard write", () => {
  const project = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-compile-"));
  temporaryDirectories.push(project);
  writeOnboardingScope(project, "repo");

  for (const [index, [incidentId, reason]] of [
    ["../../../escaped", "incident id must use lower-case kebab-case"],
    ["proof", "incident id conflicts with a reserved guard id"],
    ["git-stash-u", "incident id conflicts with a reserved guard id"],
  ].entries()) {
    const incidentPath = writeIncident(project, { ...incident, incident_id: incidentId }, `unsafe-${index}.json`);
    const result = compile(project, incidentPath);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toBe(`WHAT failed: guard compilation stopped.\nWHY: ${reason}\nFIX: correct <incident.json>, then run vibebloat compile <incident.json>\n`);
  }
  expect(existsSync(join(project, "escaped.json"))).toBeFalse();
  expect(existsSync(join(project, ".vibebloat", "guards"))).toBeFalse();
});
