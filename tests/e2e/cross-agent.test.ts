import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const guardDirectory = join(guardHome, "guards");
  mkdirSync(guardDirectory, { recursive: true });
  writeFileSync(join(guardDirectory, "no-publish.json"), JSON.stringify({
    id: "no-publish",
    class: "A",
    provenance: { incident: "test learned guard", date: "2026-07-18", source: "test" },
    match: { chokepoint: "shell", command: "npm publish" },
    action: {
      type: "block",
      message: "no-publish is blocked.",
      override: "vibebloat allow no-publish --once",
    },
    enabled: true,
  }));
  return { root, guardHome };
}

function runCli(guardHome: string, arguments_: string[]) {
  return Bun.spawnSync({
    cmd: [process.execPath, cliPath, ...arguments_],
    cwd: repositoryRoot,
    env: { ...process.env, VIBEBLOAT_HOME: guardHome },
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

test("same learned guard denies Claude Code, Codex, OpenClaw, and Hermes", () => {
  const { root, guardHome } = createLearnedGuardHome();

  const claude = runCli(guardHome, ["hook"]);
  expect(claude.exitCode).toBe(2);
  expect(claude.stderr.toString()).toContain("no-publish is blocked.");

  const codex = runCli(guardHome, ["hook", "--agent=codex"]);
  expect(codex.exitCode).toBe(0);
  expect(JSON.parse(codex.stdout.toString())).toMatchObject({
    hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no-publish is blocked." },
  });

  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "npm publish" } },
    { VIBEBLOAT_HOME: guardHome },
    root,
  )).toMatchObject({ block: true, blockReason: "no-publish is blocked." });

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
      VIBEBLOAT_HOME: guardHome,
      VIBEBLOAT_CLI: createHermesCliWrapper(root),
    },
  });
  expect(hermes.exitCode).toBe(0);
  expect(JSON.parse(hermes.stdout.toString())).toEqual({ decision: "deny", message: "no-publish is blocked." });
});
