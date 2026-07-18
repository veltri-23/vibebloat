import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runDoctor } from "../src/doctor/checks";
import { gitStashUntrackedGuard } from "../src/guards";

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

test("doctor CLI returns a three-line repair error when checks fail", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-doctor-"));
  tempDirectories.push(home);
  const result = Bun.spawnSync(["bun", "src/cli.ts", "doctor"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home, CLAUDE_CONFIG_DIR: home, CODEX_HOME: home, HERMES_HOME: join(home, "hermes"), OPENCLAW_SESSION: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(new TextDecoder().decode(result.stderr)).toContain("WHAT failed: doctor found 3 problem(s).");
});

test("doctor reports missing chokepoints for explicit and empty bindings", () => {
  const options = {
    guardDirectories: [],
    guards: [
      { ...gitStashUntrackedGuard, id: "all-agents", binds: [] },
      { ...gitStashUntrackedGuard, id: "openclaw-only", binds: ["openclaw"] as const },
    ],
    installedAgents: ["claude-code", "codex", "hermes", "openclaw"] as const,
    hookConfigs: {
      claude: "vibebloat",
      codex: "plugin_hooks = true\nvibebloat",
      hermes: "",
      openclaw: "",
    },
  };

  expect(runDoctor(options)).toContainEqual({
    status: "error",
    check: "guard-bind",
    message: "Guards all-agents require hermes, but doctor could not verify its native chokepoint.",
  });
  expect(runDoctor(options)).toContainEqual({
    status: "error",
    check: "guard-bind",
    message: "Guards all-agents, openclaw-only require openclaw, but doctor could not verify its native chokepoint.",
  });
  expect(runDoctor({
    ...options,
    hookConfigs: { ...options.hookConfigs, openclaw: "plugin vibebloat registered" },
  }).some((finding) => finding.message.includes("openclaw"))).toBeFalse();
});
