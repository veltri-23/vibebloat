import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function runHook(home: string, payload: unknown) {
  return Bun.spawnSync(["bun", "src/cli.ts", "hook"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("hook loads a compiled guard from VIBEBLOAT_HOME", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-guards-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "no-publish.json"), JSON.stringify({
    id: "no-publish", class: "A", provenance: { incident: "test", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command: "npm publish" },
    action: { type: "block", message: "Publish is blocked.", override: "vibebloat allow no-publish --once" }, enabled: true,
  }));
  const result = runHook(home, { tool_input: { command: "npm publish" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Publish is blocked.");
});

test("hook fails closed when an installed guard is invalid", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-guards-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "broken.json"), "{");
  const result = runHook(home, { tool_input: { command: "echo safe" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Guard runtime failed closed");
});
