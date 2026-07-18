import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installHermesHook } from "../src/install/hermes";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("Hermes installer copies self-contained HookRegistry hook into supplied hooks directory", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");

  expect(() => installHermesHook({ permitted: false, hooksDirectory })).toThrow("permission");
  installHermesHook({ permitted: true, hooksDirectory });

  const hook = join(hooksDirectory, "vibebloat");
  expect(existsSync(join(hook, "HOOK.yaml"))).toBeTrue();
  expect(existsSync(join(hook, "handler.py"))).toBeTrue();
  expect(readFileSync(join(hook, "HOOK.yaml"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../hermes/HOOK.yaml"), "utf8"));
  expect(readFileSync(join(hook, "handler.py"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../hermes/handler.py"), "utf8"));
  const handler = readFileSync(join(hook, "handler.py"), "utf8");
  expect(handler).toContain('os.environ.get("VIBEBLOAT_CLI")');
  expect(handler).not.toContain('ROOT / "src" / "cli.ts"');
});

test("CLI installs Hermes hook only with explicit hooks directory", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-cli-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes", "--hermes-hooks-dir", hooksDirectory],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(hooksDirectory, "vibebloat", "HOOK.yaml"))).toBeTrue();
});

test("Hermes installer atomically appends one configured pre-tool bridge without clobbering hooks", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-config-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");
  const configPath = join(directory, "config.yaml");
  writeFileSync(configPath, "model: test\nhooks:\n  pre_llm_call:\n    - command: existing-hook\nother: preserve\n");

  installHermesHook({ permitted: true, hooksDirectory, configPath });
  installHermesHook({ permitted: true, hooksDirectory, configPath });

  const config = readFileSync(configPath, "utf8");
  expect(config).toContain("model: test");
  expect(config).toContain("- command: existing-hook");
  expect(config).toContain("other: preserve");
  expect(config).toContain("pre_tool_call:");
  expect(config).toContain("python \"");
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

  installHermesHook({ permitted: true, hooksDirectory, configPath });
  installHermesHook({ permitted: true, hooksDirectory, configPath });

  const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8")) as { approvals: Array<Record<string, unknown>>; preserved: boolean };
  const command = `python "${join(hooksDirectory, "vibebloat", "handler.py")}"`;
  const approvals = allowlist.approvals.filter((approval) => approval.event === "pre_tool_call" && approval.command === command);
  expect(allowlist.preserved).toBeTrue();
  expect(approvals).toHaveLength(1);
  expect(approvals[0]?.approved_at).toBeString();
  expect(approvals[0]?.script_mtime_at_approval).toBeString();
});

const upstreamHermesSource = process.env.VIBEBLOAT_HERMES_SOURCE;
const upstreamHermesPython = process.env.VIBEBLOAT_HERMES_PYTHON;
if (upstreamHermesSource && upstreamHermesPython) test("installed Hermes bridge registers upstream pre-tool hook without a TTY", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-upstream-"));
  tempDirectories.push(directory);
  installHermesHook({ permitted: true, hooksDirectory: join(directory, "hooks"), configPath: join(directory, "config.yaml") });
  const result = Bun.spawnSync({
    cmd: [upstreamHermesPython, "-c", [
      "import json",
      "from agent import shell_hooks",
      "from hermes_cli.config import load_config",
      "from hermes_cli.plugins import get_plugin_manager",
      "shell_hooks.reset_for_tests()",
      "registered = shell_hooks.register_from_config(load_config(), accept_hooks=False)",
      "print(json.dumps({'registered': len(registered), 'has_pre_tool_hook': get_plugin_manager().has_hook('pre_tool_call')}))",
    ].join("; ")],
    env: { ...process.env, HERMES_HOME: directory, PYTHONPATH: upstreamHermesSource },
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ registered: 1, has_pre_tool_hook: true });
});

test("CLI configures Hermes shell bridge only with both explicit paths", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-cli-config-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");
  const configPath = join(directory, "config.yaml");
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes", "--hermes-hooks-dir", hooksDirectory, "--hermes-config", configPath],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(configPath, "utf8")).toContain("vibebloat-hermes-pre-tool-call");
  expect(existsSync(join(hooksDirectory, "vibebloat", "handler.py"))).toBeTrue();
});

test("Hermes installer refuses inline hook mappings without changing config", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-inline-"));
  tempDirectories.push(directory);
  const configPath = join(directory, "config.yaml");
  const original = "hooks: []\n";
  writeFileSync(configPath, original);

  expect(() => installHermesHook({ permitted: true, hooksDirectory: join(directory, "hooks"), configPath })).toThrow("block mapping");
  expect(readFileSync(configPath, "utf8")).toBe(original);
});

test("CLI does not infer a Hermes hooks directory", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-no-auto-"));
  tempDirectories.push(directory);
  const hermesHome = join(directory, "hermes");
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "../src/cli.ts"), "install", "--yes"],
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex"), HERMES_HOME: hermesHome },
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(hermesHome, "hooks", "vibebloat"))).toBeFalse();
});
