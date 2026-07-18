import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface StaticSiteFile {
  bytes: number;
  path: string;
  sha256: string;
}

export interface StaticSiteManifest {
  files: StaticSiteFile[];
  sha256: string;
}

export interface SiteDistributionReport {
  issues: string[];
  manifest: StaticSiteManifest | null;
  outputDirectory: string | null;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function filesUnder(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Static site cannot contain symbolic links: ${relative(root, path)}`);
    return entry.isDirectory() ? filesUnder(root, path) : [path];
  });
}

export function createStaticSiteManifest(siteRoot: string): StaticSiteManifest {
  const root = resolve(siteRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error("Static site output directory is missing.");
  const files = filesUnder(root).map((path) => {
    const contents = readFileSync(path);
    return {
      bytes: contents.byteLength,
      path: relative(root, path).replaceAll("\\", "/"),
      sha256: hash(contents),
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return { files, sha256: hash(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join("\n")) };
}

function localReferences(html: string): string[] {
  return [...html.matchAll(/\b(?:href|src)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => !/^(?:#|[a-z]+:|\/\/)/i.test(value))
    .map((value) => value.split(/[?#]/, 1)[0])
    .filter(Boolean);
}

export function inspectSiteDistribution(projectRoot: string): SiteDistributionReport {
  const root = resolve(projectRoot);
  const issues: string[] = [];
  let outputDirectory: string | null = null;
  try {
    const config = JSON.parse(readFileSync(resolve(root, "vercel.json"), "utf8"));
    if (typeof config?.outputDirectory === "string" && config.outputDirectory.length > 0) outputDirectory = config.outputDirectory;
    else issues.push("vercel.json must declare outputDirectory.");
  } catch {
    issues.push("vercel.json must contain valid JSON.");
  }

  if (!outputDirectory) return { issues, manifest: null, outputDirectory };
  const siteRoot = resolve(root, outputDirectory);
  if (!inside(root, siteRoot)) return { issues: [...issues, "Vercel output directory must stay inside the project root."], manifest: null, outputDirectory };

  const indexPath = resolve(siteRoot, "index.html");
  if (!existsSync(indexPath)) return { issues: [...issues, "Static site must include index.html."], manifest: null, outputDirectory };
  const html = readFileSync(indexPath, "utf8");
  for (const reference of localReferences(html)) {
    const target = resolve(siteRoot, reference);
    if (!inside(siteRoot, target)) issues.push(`Site reference escapes output directory: ${reference}`);
    else if (!existsSync(target) || !statSync(target).isFile()) issues.push(`Site reference is missing: ${reference}`);
  }

  const landmarks = ["<header", "<main", "class=\"hero\"", "class=\"receipt\"", "id=\"library\"", "id=\"install\"", "<footer"];
  let previous = -1;
  for (const landmark of landmarks) {
    const current = html.indexOf(landmark);
    if (current < 0) issues.push(`Site is missing required landmark: ${landmark}`);
    else if (current <= previous) issues.push(`Site landmark is out of contract order: ${landmark}`);
    previous = Math.max(previous, current);
  }
  if (!html.includes("Development source checkout:")) issues.push("Development install instructions must be labeled as source checkout.");
  if (/\b(?:npm install|npm i|npx)\s+vibebloat\b/i.test(html)) issues.push("Development site must not claim a public npm install.");
  if (/\b(?:process\.env|bearer\s+[a-z0-9._~-]+|service_role|supabase_service_role_key)\b/i.test(html)) issues.push("Static site must not embed runtime secrets or environment access.");

  let manifest: StaticSiteManifest | null = null;
  try {
    manifest = createStaticSiteManifest(siteRoot);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "Static site manifest failed.");
  }
  return { issues, manifest, outputDirectory };
}

export function assertSiteDistribution(projectRoot: string): SiteDistributionReport {
  const report = inspectSiteDistribution(projectRoot);
  if (report.issues.length > 0) {
    throw new Error([
      "WHAT failed: static site distribution contract.",
      `WHY: ${report.issues.join(" ")}`,
      "FIX: restore referenced site assets and Vercel output contract.",
    ].join("\n"));
  }
  return report;
}
