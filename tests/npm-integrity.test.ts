import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const roots: string[] = [];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runNpm(cwd: string, ...args: string[]): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync([npm, ...args], {
    cwd,
    env: { ...process.env, npm_config_cache: join(cwd, ".npm-cache") },
    stderr: "pipe",
    stdout: "pipe",
  });
}

test("npm refuses a package whose locked integrity hash no longer matches", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-npm-integrity-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const consumer = join(root, "consumer");
  mkdirSync(packageRoot);
  mkdirSync(consumer);

  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "vibebloat-integrity-fixture",
    version: "1.0.0",
    files: ["payload.txt"],
  }));
  writeFileSync(join(packageRoot, "payload.txt"), "trusted\n");
  expect(runNpm(packageRoot, "pack", "--ignore-scripts").exitCode).toBe(0);

  writeFileSync(join(consumer, "package.json"), JSON.stringify({
    name: "vibebloat-integrity-consumer",
    version: "1.0.0",
    private: true,
    dependencies: {
      "vibebloat-integrity-fixture": "file:../package/vibebloat-integrity-fixture-1.0.0.tgz",
    },
  }));
  const lock = runNpm(consumer, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund");
  expect(lock.exitCode, lock.stderr.toString()).toBe(0);

  rmSync(join(packageRoot, "vibebloat-integrity-fixture-1.0.0.tgz"));
  writeFileSync(join(packageRoot, "payload.txt"), "tampered\n");
  expect(runNpm(packageRoot, "pack", "--ignore-scripts").exitCode).toBe(0);
  rmSync(join(consumer, ".npm-cache"), { recursive: true, force: true });

  const install = runNpm(consumer, "ci", "--ignore-scripts", "--no-audit", "--no-fund");
  expect(install.exitCode).not.toBe(0);
  expect(install.stderr.toString()).toMatch(/EINTEGRITY|integrity checksum failed/i);
});
