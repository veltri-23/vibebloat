import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installHermesHook } from "../src/install/hermes";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const pythonExecutable = Bun.which("python") ?? Bun.which("python3");
if (!pythonExecutable) throw new Error("Python is required for Hermes installer tests.");

function createVibeBloatCli(directory: string): string {
  const wrapper = join(directory, process.platform === "win32" ? "vibebloat.cmd" : "vibebloat");
  const source = join(import.meta.dir, "../src/cli.ts");
  writeFileSync(wrapper, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${source}" %*\r\n`
    : `#!/usr/bin/env sh\n"${process.execPath}" "${source}" "$@"\n`);
  if (process.platform !== "win32") chmodSync(wrapper, 0o755);
  return wrapper;
}

test("Hermes installer copies self-contained HookRegistry hook into supplied hooks directory", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");

  expect(() => installHermesHook({ permitted: false, hermesHome: directory, pythonExecutable: process.execPath })).toThrow("permission");
  installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable });

  const hook = join(hooksDirectory, "vibebloat");
  expect(existsSync(join(hook, "HOOK.yaml"))).toBeTrue();
  expect(existsSync(join(hook, "handler.py"))).toBeTrue();
  expect(readFileSync(join(hook, "HOOK.yaml"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../hermes/HOOK.yaml"), "utf8"));
  expect(readFileSync(join(hook, "handler.py"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../hermes/handler.py"), "utf8"));
  const handler = readFileSync(join(hook, "handler.py"), "utf8");
  expect(handler).toContain('os.environ.get("VIBEBLOAT_CLI")');
  expect(handler).not.toContain('ROOT / "src" / "cli.ts"');
});

test("CLI installs Hermes hook only with explicit home and Python interpreter", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-cli-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes", "--hermes-home", directory, "--hermes-python", pythonExecutable],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(directory, "hooks", "vibebloat", "HOOK.yaml"))).toBeTrue();
});

test("Hermes installer atomically appends one configured pre-tool bridge without clobbering hooks", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-config-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");
  const configPath = join(directory, "config.yaml");
  writeFileSync(configPath, "model: test\nhooks:\n  pre_llm_call:\n    - command: existing-hook\nother: preserve\n");

  installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable });
  installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable });

  const config = readFileSync(configPath, "utf8");
  expect(config).toContain("model: test");
  expect(config).toContain("- command: existing-hook");
  expect(config).toContain("other: preserve");
  expect(config).toContain("pre_tool_call:");
  expect(config).toContain(`\"${pythonExecutable}\" \"`);
  expect(config).toContain("matcher: '^(terminal|execute_code|patch|write_file)$'");
  expect(config.match(/vibebloat-hermes-pre-tool-call/g)?.length).toBe(1);
});

test("Hermes installer adds only its exact pre-tool command to the upstream allowlist", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-allowlist-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");
  const configPath = join(directory, "config.yaml");
  const allowlistPath = join(directory, "shell-hooks-allowlist.json");
  writeFileSync(allowlistPath, JSON.stringify({ approvals: [{ event: "pre_tool_call", command: "existing-hook" }], preserved: true }));

  installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable });
  installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable });

  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as { approvals: Array<Record<string, unknown>>; preserved: boolean };
  const approvals = allowlist.approvals.filter((approval) => approval.event === "pre_tool_call" && typeof approval.command === "string" && approval.command.startsWith(`\"${pythonExecutable}\" \"${join(hooksDirectory, "vibebloat", "handler.py")}\" --vibebloat-handler-sha=`));
  expect(allowlist.preserved).toBeTrue();
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.approved_at).toBeString();
  expect(approvals[0]?.script_mtime_at_approval).toBeString();
});

const upstreamHermesSource = process.env.VIBEBLOAT_HERMES_SOURCE;
const upstreamHermesPython = process.env.VIBEBLOAT_HERMES_PYTHON;
if (upstreamHermesSource && upstreamHermesPython) test("installed Hermes bridge registers and blocks through upstream pre-tool hooks without a TTY", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-upstream-"));
  tempDirectories.push(directory);
  installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable: upstreamHermesPython });
  const upstreamScript = [
    "import json",
    "from agent import shell_hooks",
    "from hermes_cli.config import load_config",
    "from hermes_cli.plugins import get_plugin_manager, get_pre_tool_call_directive",
    "shell_hooks.reset_for_tests()",
    "registered = shell_hooks.register_from_config(load_config(), accept_hooks=False)",
    "decision, message = get_pre_tool_call_directive('terminal', {'command': 'git stash -u'})",
    "print(json.dumps({'registered': len(registered), 'has_pre_tool_hook': get_plugin_manager().has_hook('pre_tool_call'), 'decision': decision, 'message': message}))",
  ].join("; ");
  const result = Bun.spawnSync({
    cmd: [upstreamHermesPython, "-c", upstreamScript],
    env: { ...process.env, HERMES_HOME: directory, PYTHONPATH: upstreamHermesSource, VIBEBLOAT_CLI: createVibeBloatCli(directory) },
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({
    registered: 1,
    has_pre_tool_hook: true,
    decision: "block",
    message: "07-15 this deleted untracked files. Use git stash -u -- <path> or commit first.",
  });

  const handlerPath = join(directory, "hooks", "vibebloat", "handler.py");
  writeFileSync(handlerPath, `${readFileSync(handlerPath, "utf8")}\n`);
  const tampered = Bun.spawnSync({
    cmd: [upstreamHermesPython, "-c", upstreamScript],
    env: { ...process.env, HERMES_HOME: directory, PYTHONPATH: upstreamHermesSource, VIBEBLOAT_CLI: createVibeBloatCli(directory) },
  });
  expect(tampered.exitCode).toBe(0);
  expect(JSON.parse(tampered.stdout.toString())).toMatchObject({
    registered: 1,
    has_pre_tool_hook: true,
    decision: "block",
    message: "VibeBloat hook integrity check failed.",
  });
});

test("CLI configures Hermes shell bridge only with explicit home and Python", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-cli-config-"));
  tempDirectories.push(directory);
  const configPath = join(directory, "config.yaml");
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes", "--hermes-home", directory, "--hermes-python", pythonExecutable],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(configPath, "utf8")).toContain("vibebloat-hermes-pre-tool-call");
  expect(existsSync(join(directory, "hooks", "vibebloat", "handler.py"))).toBeTrue();
});

test("Hermes installer refuses inline hook mappings without changing config", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-inline-"));
  tempDirectories.push(directory);
  const configPath = join(directory, "config.yaml");
  const original = "hooks: []\n";
  writeFileSync(configPath, original);

  expect(() => installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable })).toThrow("block mapping");
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("CLI rejects legacy arbitrary Hermes config paths", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-no-auto-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes", "--hermes-hooks-dir", join(directory, "hooks"), "--hermes-config", join(directory, "other.yaml")],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("--hermes-home <path> --hermes-python <path>");
});

test("Hermes installer rejects non-Python executables before writing files", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-non-python-"));
  tempDirectories.push(directory);

  expect(() => installHermesHook({ permitted: true, hermesHome: directory, pythonExecutable: process.execPath })).toThrow("runtime check");
  expect(existsSync(join(directory, "hooks", "vibebloat", "HOOK.yaml"))).toBeFalse();
  expect(existsSync(join(directory, "config.yaml"))).toBeFalse();
  expect(existsSync(join(directory, "shell-hooks-allowlist.json"))).toBeFalse();
});

test("CLI rejects non-Python Hermes before native hook writes", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-cli-non-python-"));
  tempDirectories.push(directory);
  const claudeHome = join(directory, "claude");
  const codexHome = join(directory, "codex");
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes", "--hermes-home", directory, "--hermes-python", process.execPath],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
  });

  expect(result.exitCode).toBe(1);
  expect(existsSync(join(directory, "hooks", "vibebloat", "HOOK.yaml"))).toBeFalse();
  expect(existsSync(join(directory, "config.yaml"))).toBeFalse();
  expect(existsSync(join(directory, "shell-hooks-allowlist.json"))).toBeFalse();
  expect(existsSync(join(claudeHome, "settings.json"))).toBeFalse();
  expect(existsSync(join(codexHome, "config.toml"))).toBeFalse();
});
