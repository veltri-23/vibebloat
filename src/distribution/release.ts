import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";

export type ReleaseArtifactId = "windows-x64" | "macos-x64" | "macos-arm64" | "linux-x64";

export interface ReleaseArtifact {
  arch: "x64" | "arm64";
  bunTarget: Bun.Build.Target;
  filename: string;
  id: ReleaseArtifactId;
  platform: "win32" | "darwin" | "linux";
}

export const RELEASE_ARTIFACTS: readonly ReleaseArtifact[] = Object.freeze([
  { id: "windows-x64", platform: "win32", arch: "x64", bunTarget: "bun-windows-x64-baseline", filename: "vibebloat-windows-x64.exe" },
  { id: "macos-x64", platform: "darwin", arch: "x64", bunTarget: "bun-darwin-x64", filename: "vibebloat-macos-x64" },
  { id: "macos-arm64", platform: "darwin", arch: "arm64", bunTarget: "bun-darwin-arm64", filename: "vibebloat-macos-arm64" },
  { id: "linux-x64", platform: "linux", arch: "x64", bunTarget: "bun-linux-x64-baseline", filename: "vibebloat-linux-x64" },
]);

export function releaseArtifactById(id: string): ReleaseArtifact | null {
  return RELEASE_ARTIFACTS.find((artifact) => artifact.id === id) ?? null;
}

export function selectReleaseArtifact(platform: string, arch: string): ReleaseArtifact | null {
  return RELEASE_ARTIFACTS.find((artifact) => artifact.platform === platform && artifact.arch === arch) ?? null;
}

function executableMagic(path: string): string {
  const descriptor = openSync(path, "r");
  const bytes = Buffer.alloc(4);
  try {
    readSync(descriptor, bytes, 0, bytes.length, 0);
  } finally {
    closeSync(descriptor);
  }
  return bytes.toString("hex");
}

export function inspectReleaseArtifacts(projectRoot: string, artifacts: readonly ReleaseArtifact[]): string[] {
  const distributionRoot = resolve(projectRoot, "dist");
  const issues: string[] = [];
  for (const artifact of artifacts) {
    const path = resolve(distributionRoot, artifact.filename);
    try {
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) issues.push(`${artifact.filename} must be a regular file.`);
      if (metadata.size === 0) issues.push(`${artifact.filename} must not be empty.`);
      if (metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0) {
        const magic = executableMagic(path);
        const expected = artifact.platform === "win32" ? "4d5a" : artifact.platform === "linux" ? "7f454c46" : "cffaedfe";
        if (!magic.startsWith(expected)) issues.push(`${artifact.filename} has invalid executable bytes.`);
      }
    } catch {
      issues.push(`${artifact.filename} is missing.`);
    }
  }
  return issues;
}

export function assertReleaseArtifacts(projectRoot: string, artifacts: readonly ReleaseArtifact[]): void {
  const issues = inspectReleaseArtifacts(projectRoot, artifacts);
  if (issues.length === 0) return;
  throw new Error([
    "WHAT failed: standalone release artifact contract.",
    `WHY: ${issues.join(" ")}`,
    "FIX: bun run build:release",
  ].join("\n"));
}
