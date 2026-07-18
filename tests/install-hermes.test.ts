import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
