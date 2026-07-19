import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardedBeforeToolCall } from "../../src/hooks/openclaw-plugin";

const temporaryDirectories: string[] = [];
const repositoryRoot = join(import.meta.dir, "../..");
const cliPath = join(repositoryRoot, "src", "cli.ts");
const hermesHandlerPath = join(repositoryRoot, "hermes", "handler.py");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createLearnedGuardHome(): { root: string; guardHome: string } {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-cross-agent-"));
  temporaryDirectories.push(root);
  const guardHome = join(root, "guard-home");
  const incidentPath = join(root, "incident.json");
  writeFileSync(incidentPath, JSON.stringify({
    incident_id: "no-publish",
    class: "A",
    chokepoint: "shell",
    command: "npm publish",
    condition: "test learned guard",
    evidence_refs: ["test"],
    severity: 5,
    frequency: 1,
    recency: "2026-07-18",
  }));
  const result = Bun.spawnSync({
    cmd: [process.execPath, cliPath, "compile", incidentPath],
    cwd: root,
    env: { ...process.env, VIBEBLOAT_HOME: guardHome },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  if (!existsSync(join(guardHome, "guards", "proof.json"))) throw new Error("compile receipt missing");
  return { root, guardHome };
}

function runCli(guardHome: string, arguments_: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, ...arguments_],
    cwd: repositoryRoot,
    env: { ...process.env, USERPROFILE: guardHome, HOME: guardHome, VIBEBLOAT_HOME: guardHome },
    stdin: new Blob([JSON.stringify({ tool_input: { command: "npm publish" } })]),
  });
}

function createHermesCliWrapper(root: string): string {
  const wrapper = join(root, process.platform === "win32" ? "vibebloat.cmd" : "vibebloat");
  const command = process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${cliPath}" %*\r\n`
    : `#!/usr/bin/env sh\n"${process.execPath}" "${cliPath}" "$@"\n`;
  writeFileSync(wrapper, command);
  if (process.platform !== "win32") chmodSync(wrapper, 0o755);
  return wrapper;
}

function blockReceipt(guardId: string, incident: string, why: string, date = "2026-07-18"): string {
  return [
    `BLOCKED  guard: ${guardId}  class: A`,
    `incident: ${incident}  date: ${date}`,
    `why: ${why}`,
    `fix: vibebloat allow ${guardId} --once`,
  ].join("\n");
}

test("same learned guard denies Claude Code, Codex, OpenClaw, and Hermes", () => {
  const { root, guardHome } = createLearnedGuardHome();
  const receipt = blockReceipt("no-publish", "test learned guard", "VibeBloat found no-publish in 1 incident.");

  const claude = runCli(guardHome, ["hook"]);
  expect(claude.exitCode).toBe(2);
  expect(claude.stderr.toString()).toContain("VibeBloat found no-publish in 1 incident.");

  const codex = runCli(guardHome, ["hook", "--agent=codex"]);
  expect(codex.exitCode).toBe(0);
  expect(JSON.parse(codex.stdout.toString())).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: receipt },
  });

  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "npm publish" } },
    { USERPROFILE: root, HOME: root, VIBEBLOAT_HOME: guardHome },
    root,
  )).toMatchObject({ block: true, blockReason: receipt });

  const hermesScript = [
    "import asyncio, importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('vibebloat_handler', sys.argv[1])",
    "handler = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(handler)",
    "result = asyncio.run(handler.handle('tool:terminal', {'command': 'npm publish'}))",
    "print(json.dumps(result))",
  ].join("\n");
  const hermes = Bun.spawnSync({
    cmd: [process.env.PYTHON ?? "python", "-c", hermesScript, hermesHandlerPath],
    cwd: root,
    env: {
      ...process.env,
      USERPROFILE: root,
      HOME: root,
      VIBEBLOAT_HOME: guardHome,
      VIBEBLOAT_CLI: createHermesCliWrapper(root),
    },
  });
  expect(hermes.exitCode).toBe(0);
  expect(JSON.parse(hermes.stdout.toString())).toEqual({ decision: "deny", message: receipt });
});

test("Hermes bridge resolves a repository Git alias before blocking a compiled guard", () => {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-hermes-alias-"));
  temporaryDirectories.push(root);
  const guardHome = join(root, "guard-home");
  const incidentPath = join(root, "incident.json");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "[alias]\n  rh = reset --hard\n");
  writeFileSync(incidentPath, JSON.stringify({
    incident_id: "no-git-reset-hard",
    class: "A",
    chokepoint: "shell",
    command: "git reset",
    condition: "test Hermes alias bridge",
    evidence_refs: ["test"],
    severity: 5,
    frequency: 1,
    recency: "2026-07-18",
  }));
  const compiled = Bun.spawnSync({
    cmd: [process.execPath, cliPath, "compile", incidentPath],
    cwd: root,
    env: { ...process.env, VIBEBLOAT_HOME: guardHome },
  });
  expect(compiled.exitCode).toBe(0);

  const hermesScript = [
    "import asyncio, importlib.util, json, sys",
    "spec = importlib.util.spec_from_file_location('vibebloat_handler', sys.argv[1])",
    "handler = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(handler)",
    "result = asyncio.run(handler.handle('tool:terminal', {'command': 'git rh'}))",
    "print(json.dumps(result))",
  ].join("\n");
  const hermes = Bun.spawnSync({
    cmd: [process.env.PYTHON ?? "python", "-c", hermesScript, hermesHandlerPath],
    cwd: root,
    env: {
      ...process.env,
      USERPROFILE: root,
      HOME: root,
      VIBEBLOAT_HOME: guardHome,
      VIBEBLOAT_CLI: createHermesCliWrapper(root),
    },
  });

  expect(hermes.exitCode).toBe(0);
  expect(JSON.parse(hermes.stdout.toString())).toEqual({
    decision: "deny",
    message: blockReceipt("git-reset-hard", "git reset --hard destroyed uncommitted work", "07-15 this destroyed uncommitted work. Use git stash first, or reset --soft to keep changes stag", "2026-07-15"),
  });
});
