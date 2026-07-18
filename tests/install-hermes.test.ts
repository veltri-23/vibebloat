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
