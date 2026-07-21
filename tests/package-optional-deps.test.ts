import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { globalGuardHome } from "../src/guard-home";
import { defaultIncidentStorePath, IncidentStore } from "../src/ingest/incidents-store";

const roots: string[] = [];
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof Bun.spawnSync> {
  return Bun.spawnSync(command, {
    cwd,
    env: { ...env, npm_config_cache: join(cwd, ".npm-cache") },
    stderr: "pipe",
    stdout: "pipe",
  });
}

test("packed npx CLI works without optional neural dependencies", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-package-no-optional-"));
  roots.push(root);
  const packageRoot = join(root, "package");
  const consumer = join(root, "consumer");
  mkdirSync(packageRoot);
  mkdirSync(consumer);

  const repositoryRoot = join(import.meta.dir, "..");
  const packed = run([npm, "pack", repositoryRoot, "--ignore-scripts", "--json"], packageRoot);
  expect(packed.exitCode, packed.stderr.toString()).toBe(0);
  const [{ filename }] = JSON.parse(packed.stdout.toString()) as [{ filename: string }];
  const strippedRoot = join(root, "stripped");
  mkdirSync(strippedRoot);
  const extracted = run(["tar", "-xzf", basename(filename), "-C", strippedRoot], packageRoot);
  expect(extracted.exitCode, extracted.stderr.toString()).toBe(0);
  const strippedPackage = join(strippedRoot, "package");
  const manifestPath = join(strippedPackage, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { optionalDependencies?: unknown };
  delete manifest.optionalDependencies;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const repacked = run([npm, "pack", strippedPackage, "--ignore-scripts", "--json"], packageRoot);
  expect(repacked.exitCode, repacked.stderr.toString()).toBe(0);
  const [{ filename: strippedFilename }] = JSON.parse(repacked.stdout.toString()) as [{ filename: string }];
  const tarball = join(packageRoot, basename(strippedFilename));
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true }));
  const installed = run([
    npm,
    "install",
    tarball,
    "--no-audit",
    "--no-fund",
  ], consumer);
  expect(installed.exitCode, installed.stderr.toString()).toBe(0);

  expect(existsSync(join(consumer, "node_modules", "@huggingface", "transformers"))).toBe(false);
  expect(existsSync(join(consumer, "node_modules", "onnxruntime-node"))).toBe(false);

  const probe = run([npx, "--no-install", "vibebloat", "__distribution_probe__"], consumer);
  expect(probe.exitCode, probe.stderr.toString()).toBe(0);
  expect(probe.stdout.toString().trim()).toBe("vibebloat:dist:ok");

  const configDirectory = join(consumer, ".vibebloat");
  mkdirSync(configDirectory);
  const configPath = join(configDirectory, "config.toml");
  const hookPayload = JSON.stringify({ tool_input: { command: "shelve my uncommitted changes" } });
  for (const mode of ["lexical", "off"]) {
    writeFileSync(configPath, `[semantic]\nrecall = ${mode}\n`);
    const hook = Bun.spawnSync([npx, "--no-install", "vibebloat", "hook"], {
      cwd: consumer,
      env: { ...process.env, VIBEBLOAT_HOME: join(root, "home") },
      stdin: new Blob([hookPayload]),
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(hook.exitCode, hook.stderr.toString()).toBe(0);
    expect(hook.stderr.toString()).not.toContain("local semantic recall");
  }

  const env = { ...process.env, VIBEBLOAT_HOME: join(root, "home") };
  const store = new IncidentStore({ path: defaultIncidentStorePath(consumer, globalGuardHome(env)) });
  store.record({
    incidentId: "seeded-incident",
    command: "npm run build prod",
    condition: "it clobbered release output",
    consequence: "restore last good build",
    signature: "npm|run|build|prod",
  });
  try { store.close(); } catch { /* INSERT committed; Bun SQLite can retain a Windows lock. */ }
  writeFileSync(configPath, "[semantic]\nrecall = local\n");
  const local = Bun.spawnSync([npx, "--no-install", "vibebloat", "hook"], {
    cwd: consumer,
    env,
    stdin: new Blob([hookPayload]),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(local.exitCode, local.stderr.toString()).toBe(0);
  expect(local.stderr.toString()).toBe(
    "WHAT skipped: local semantic recall is unavailable.\n" +
    "WHY: optional @huggingface/transformers and onnxruntime-node runtime could not load.\n" +
    "FIX: npm install @huggingface/transformers onnxruntime-node\n",
  );

  // Package contains worker source, but omitted dependencies remain absent.
  expect(readFileSync(join(consumer, "node_modules", "vibebloat", "src", "ingest", "embed-worker.mjs"), "utf8"))
    .toContain('await import("@huggingface/transformers")');
}, 120_000);
