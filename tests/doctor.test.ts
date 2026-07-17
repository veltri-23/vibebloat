import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDoctor } from "../src/doctor/checks";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("doctor reports missing proof and hook drift", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-"));
  tempDirectories.push(directory);
  writeFileSync(join(directory, "guard.json"), "{}");

  expect(runDoctor({ guardDirectory: directory, hookConfigs: { claude: "{}", codex: "plugin_hooks = true" } })).toEqual([
    { status: "error", check: "proof", message: "No runner-written proof marker found." },
    { status: "error", check: "claude-hook", message: "Claude Code hook is missing." },
    { status: "error", check: "codex-hook", message: "Codex hook is missing." },
  ]);
});
