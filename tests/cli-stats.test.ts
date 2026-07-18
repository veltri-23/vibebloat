import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("stats reports only local guard and proof counts", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-stats-"));
  temporaryDirectories.push(home);
  const guards = join(home, "guards");
  mkdirSync(guards);
  writeFileSync(join(guards, "one.json"), JSON.stringify({ command: "never printed" }));
  writeFileSync(join(guards, "proof.json"), JSON.stringify({ command: "also never printed" }));

  const result = Bun.spawnSync(["bun", "src/cli.ts", "stats"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, VIBEBLOAT_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ guards: 1, receipts: 1 });
  expect(result.stdout.toString()).not.toContain("never printed");
});
