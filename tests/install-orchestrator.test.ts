import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installNativeHooks } from "../src/install/orchestrator";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("installer changes configs only after explicit permission", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-install-"));
  tempDirectories.push(directory);
  const claude = join(directory, "claude.json"); const codex = join(directory, "config.toml");
  writeFileSync(claude, "{}"); writeFileSync(codex, "[features]\njs_repl = false\n");
  expect(() => installNativeHooks({ permitted: false, claudePath: claude, codexPath: codex, command: "vibebloat hook" })).toThrow("permission");
  installNativeHooks({ permitted: true, claudePath: claude, codexPath: codex, command: "vibebloat hook" });
  expect(readFileSync(claude, "utf8")).toContain("vibebloat hook");
  expect(readFileSync(codex, "utf8")).toContain("plugin_hooks = true");
  expect(readFileSync(codex, "utf8")).toContain("vibebloat hook --agent=codex");
});

test("installer wires verified shim and append-only hooks without starting a watcher", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-install-"));
  tempDirectories.push(directory);
  const claude = join(directory, "claude.json"); const codex = join(directory, "config.toml");
  const hook = join(directory, "pre-commit");
  writeFileSync(claude, "{}"); writeFileSync(codex, ""); writeFileSync(hook, "#!/bin/sh\necho existing\n");

  expect(installNativeHooks({
    permitted: true, claudePath: claude, codexPath: codex, command: "vibebloat hook",
    fallback: {
      shimDirectory: "C:/tools/vibebloat",
      readPath: (shell) => shell === "pwsh" ? "C:/tools/vibebloat;C:/Windows" : "/c/tools/vibebloat:/usr/bin",
      gitHookPaths: [hook],
    },
  })).toBeUndefined();

  expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho existing\n# vibebloat:start\nvibebloat hook\n# vibebloat:end\n");
});
