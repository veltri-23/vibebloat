import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCliDistribution, inspectCliDistribution } from "../src/distribution/cli";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("repository CLI package surface remains source-checkout only and runnable by Bun", () => {
  const report = assertCliDistribution(join(import.meta.dir, ".."));
  expect(report).toEqual({
    entrypoint: "bin/vibebloat.js",
    issues: [],
    releaseStatus: "development",
    version: "0.0.0-spike",
  });

  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", report.entrypoint!), "__distribution_probe__"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString().trim().split(/\r?\n/)).toEqual([
    "WHAT failed: expected allow, compile, eval, hook, git-hook, disable, doctor, init, onboard, install, uninstall, update, scan, stats, sync, watch, daily, rules, or email.",
    "WHY: no supported mode supplied.",
    "FIX: bun src/cli.ts doctor",
  ]);
});

test("CLI distribution rejects escaping and unpackaged binary targets", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-distribution-cli-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "vibebloat.js"), "#!/usr/bin/env bun\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "vibebloat",
    version: "0.1.0",
    private: false,
    engines: { bun: ">=1.3.0" },
    scripts: { build: "bun scripts/build.ts" },
    files: ["src"],
    bin: { vibebloat: "../outside.js" },
  }));

  expect(inspectCliDistribution(root).issues).toContain("vibebloat binary must stay inside the package root.");

  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "vibebloat",
    version: "0.1.0",
    private: false,
    engines: { bun: ">=1.3.0" },
    scripts: { build: "bun scripts/build.ts" },
    files: ["src"],
    bin: { vibebloat: "bin/vibebloat.js" },
  }));
  expect(inspectCliDistribution(root).issues).toContain("package files must include the vibebloat binary target.");
});

test("prerelease CLI metadata cannot imply a public package", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-distribution-cli-"));
  roots.push(root);
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "vibebloat.js"), "#!/usr/bin/env bun\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "vibebloat",
    version: "0.1.0-rc.1",
    private: false,
    engines: { bun: ">=1.3.0" },
    scripts: { build: "bun scripts/build.ts" },
    files: ["bin"],
    bin: { vibebloat: "bin/vibebloat.js" },
  }));

  expect(inspectCliDistribution(root)).toMatchObject({
    releaseStatus: "development",
    issues: ["prerelease builds must remain private."],
  });
});
