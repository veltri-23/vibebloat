import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("install requires explicit permission before creating agent configs", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const result = Bun.spawnSync(["bun", "src/cli.ts", "install"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(directory, "claude"), CODEX_HOME: join(directory, "codex") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("FIX: vibebloat install --yes");
  expect(existsSync(join(directory, "claude", "settings.json"))).toBeFalse();
});

test("install creates Claude JSON and Codex TOML hooks after consent", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-install-"));
  tempDirectories.push(directory);
  const claudeHome = join(directory, "claude"); const codexHome = join(directory, "codex");
  const result = Bun.spawnSync(["bun", "src/cli.ts", "install", "--yes"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(claudeHome, "settings.json"), "utf8")).toContain("vibebloat hook");
  const codex = readFileSync(join(codexHome, "config.toml"), "utf8");
  expect(codex).toContain("plugin_hooks = true");
  expect(codex).toContain("vibebloat hook --agent=codex");
});
