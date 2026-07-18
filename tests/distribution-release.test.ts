import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertReleaseArtifacts,
  inspectReleaseArtifacts,
  RELEASE_ARTIFACTS,
  releaseArtifactById,
  selectReleaseArtifact,
} from "../src/distribution/release";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("release selector maps supported runtimes to deterministic platform artifacts", () => {
  expect(RELEASE_ARTIFACTS.map(({ id, filename, bunTarget }) => ({ id, filename, bunTarget }))).toEqual([
    { id: "windows-x64", filename: "vibebloat-windows-x64.exe", bunTarget: "bun-windows-x64-baseline" },
    { id: "macos-x64", filename: "vibebloat-macos-x64", bunTarget: "bun-darwin-x64" },
    { id: "macos-arm64", filename: "vibebloat-macos-arm64", bunTarget: "bun-darwin-arm64" },
    { id: "linux-x64", filename: "vibebloat-linux-x64", bunTarget: "bun-linux-x64-baseline" },
  ]);
  expect(selectReleaseArtifact("win32", "x64")?.id).toBe("windows-x64");
  expect(selectReleaseArtifact("darwin", "arm64")?.id).toBe("macos-arm64");
  expect(selectReleaseArtifact("linux", "arm64")).toBeNull();
  expect(releaseArtifactById("unknown")).toBeNull();
});

test("release artifact contract rejects missing, empty, and linked files", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-release-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  const artifact = RELEASE_ARTIFACTS[0]!;
  expect(inspectReleaseArtifacts(root, [artifact])).toEqual([`${artifact.filename} is missing.`]);

  const path = join(root, "dist", artifact.filename);
  writeFileSync(path, "");
  expect(inspectReleaseArtifacts(root, [artifact])).toEqual([`${artifact.filename} must not be empty.`]);
  writeFileSync(path, "text");
  expect(inspectReleaseArtifacts(root, [artifact])).toEqual([`${artifact.filename} has invalid executable bytes.`]);
  writeFileSync(path, Buffer.from("4d5a9000", "hex"));
  expect(() => assertReleaseArtifacts(root, [artifact])).not.toThrow();

  const target = join(root, "target.exe");
  writeFileSync(target, Buffer.from("4d5a9000", "hex"));
  rmSync(path);
  symlinkSync(target, path, "file");
  expect(inspectReleaseArtifacts(root, [artifact])).toEqual([`${artifact.filename} must be a regular file.`]);
});

test("release build rejects unknown targets with three-line recovery", () => {
  const project = join(import.meta.dir, "..");
  const result = Bun.spawnSync([process.execPath, "scripts/build.ts", "--target", "plan9-x64"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString().trim().split(/\r?\n/)).toEqual([
    "WHAT failed: standalone release build.",
    "WHY: unsupported target plan9-x64.",
    "FIX: bun scripts/build.ts --target windows-x64|macos-x64|macos-arm64|linux-x64",
  ]);
});
