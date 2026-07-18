import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

interface PackageManifest {
  bin?: Record<string, unknown>;
  engines?: { bun?: unknown };
  files?: unknown[];
  name?: unknown;
  private?: unknown;
  scripts?: Record<string, unknown>;
  version?: unknown;
}

export interface CliDistributionReport {
  entrypoint: string | null;
  issues: string[];
  releaseStatus: "development" | "public";
  version: string | null;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function loadManifest(path: string): PackageManifest | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function inspectCliDistribution(projectRoot: string): CliDistributionReport {
  const root = resolve(projectRoot);
  const issues: string[] = [];
  const manifest = loadManifest(resolve(root, "package.json"));
  if (!manifest) return { entrypoint: null, issues: ["package.json must contain a JSON object."], releaseStatus: "development", version: null };

  const version = typeof manifest.version === "string" ? manifest.version : null;
  const releaseStatus = manifest.private === false && version !== null && !version.includes("-") ? "public" : "development";
  if (manifest.name !== "vibebloat") issues.push("package name must be vibebloat.");
  if (!version) issues.push("package version must be a non-empty string.");
  if (manifest.engines?.bun !== ">=1.3.0") issues.push("package must require Bun >=1.3.0.");
  if (manifest.scripts?.build !== "bun scripts/build.ts") issues.push("build script must compile through scripts/build.ts.");

  const binValue = manifest.bin?.vibebloat;
  let entrypoint: string | null = null;
  if (typeof binValue !== "string" || binValue.length === 0) {
    issues.push("package must expose the vibebloat binary.");
  } else {
    const candidate = resolve(root, binValue);
    if (!inside(root, candidate)) {
      issues.push("vibebloat binary must stay inside the package root.");
    } else if (!existsSync(candidate) || !statSync(candidate).isFile()) {
      issues.push(`vibebloat binary target is missing: ${binValue}`);
    } else {
      entrypoint = binValue.replaceAll("\\", "/");
      if (!readFileSync(candidate, "utf8").startsWith("#!/usr/bin/env bun\n")) issues.push("vibebloat binary must use the Bun env shebang.");
    }
  }

  const packagedFiles = Array.isArray(manifest.files) ? manifest.files.filter((value): value is string => typeof value === "string") : [];
  if (entrypoint && !packagedFiles.some((path) => entrypoint === path || entrypoint.startsWith(`${path.replace(/\/$/, "")}/`))) {
    issues.push("package files must include the vibebloat binary target.");
  }
  if (releaseStatus === "development" && manifest.private !== true) issues.push("prerelease builds must remain private.");

  return { entrypoint, issues, releaseStatus, version };
}

export function assertCliDistribution(projectRoot: string): CliDistributionReport {
  const report = inspectCliDistribution(projectRoot);
  if (report.issues.length > 0) {
    throw new Error([
      "WHAT failed: CLI distribution contract.",
      `WHY: ${report.issues.join(" ")}`,
      "FIX: align package.json and bin/vibebloat.js with distribution contract.",
    ].join("\n"));
  }
  return report;
}
