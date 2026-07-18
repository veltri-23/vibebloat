import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSiteDistribution, createStaticSiteManifest, inspectSiteDistribution } from "../src/distribution/site";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("Vercel baseline has complete local assets and reproducible bytes", () => {
  const project = join(import.meta.dir, "..");
  const report = assertSiteDistribution(project);
  expect(report.outputDirectory).toBe("site");
  expect(report.manifest?.files.map((file) => file.path)).toEqual([
    "index.html",
    "library-filter.js",
    "privacy.html",
    "styles.css",
  ]);
  expect(report.manifest).toEqual(createStaticSiteManifest(join(project, "site")));
  expect(report.manifest?.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test("site validation reports missing local assets", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-distribution-site-"));
  roots.push(root);
  mkdirSync(join(root, "site"));
  writeFileSync(join(root, "vercel.json"), JSON.stringify({ outputDirectory: "site" }));
  writeFileSync(join(root, "site", "index.html"), [
    "<header></header><main>",
    '<section class="hero"></section><section class="receipt"></section>',
    '<section id="library"></section><section id="install">Development source checkout:</section>',
    '</main><footer></footer><link rel="stylesheet" href="missing.css">',
  ].join(""));

  expect(inspectSiteDistribution(root).issues).toEqual(["Site reference is missing: missing.css"]);
});

test("site validation rejects public install claims and output traversal", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-distribution-site-"));
  roots.push(root);
  mkdirSync(join(root, "site"));
  writeFileSync(join(root, "site", "index.html"), [
    "<header></header><main>",
    '<section class="hero"></section><section class="receipt"></section>',
    '<section id="library"></section><section id="install">Development source checkout: npx vibebloat</section>',
    "</main><footer></footer>",
  ].join(""));
  writeFileSync(join(root, "vercel.json"), JSON.stringify({ outputDirectory: "site" }));
  expect(inspectSiteDistribution(root).issues).toContain("Development site must not claim a public npm install.");

  writeFileSync(join(root, "vercel.json"), JSON.stringify({ outputDirectory: "../outside" }));
  expect(inspectSiteDistribution(root).issues).toContain("Vercel output directory must stay inside the project root.");
});
