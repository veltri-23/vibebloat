import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendFiring } from "../src/audit/firings";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("stats reports local guard, proof, and aggregate firing counts only", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-stats-"));
  temporaryDirectories.push(home);
  const user = join(home, "user");
  const guards = join(home, "guards");
  mkdirSync(guards);
  writeFileSync(join(guards, "one.json"), JSON.stringify({ command: "never printed" }));
  writeFileSync(join(guards, "proof.json"), JSON.stringify({ command: "also never printed" }));
  const auditHome = join(user, ".vibebloat");
  const now = new Date();
  const metadata = { guardId: "git-stash-u", class: "A", chokepoint: "shell", actionType: "block", blocked: true } as const;
  appendFiring(auditHome, true, metadata, new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000));
  appendFiring(auditHome, true, metadata, new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));
  appendFiring(auditHome, true, metadata, now);

  const result = Bun.spawnSync(["bun", "src/cli.ts", "stats"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, USERPROFILE: user, HOME: user, VIBEBLOAT_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ guards: 1, receipts: 1, firingsToday: 1, firingsWeek: 2 });
  expect(result.stdout.toString()).not.toContain("never printed");
  expect(result.stdout.toString()).not.toContain("git-stash-u");
});
