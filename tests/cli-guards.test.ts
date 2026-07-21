import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { globalGuardHome } from "../src/guard-home";
import { defaultIncidentStorePath } from "../src/ingest/incidents-store";
import { type DirtyGitContext, restoreCwd, useDirtyGitCwd } from "./helpers/dirty-git-cwd";

const tempDirectories: string[] = [];
const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
let dirtyCtx: DirtyGitContext;
let originalCwd: string;
beforeAll(() => {
  originalCwd = process.cwd();
  dirtyCtx = useDirtyGitCwd();
});
afterAll(() => { restoreCwd(originalCwd, dirtyCtx); });
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function runHook(home: string, payload: unknown, environment: Record<string, string | undefined> = {}) {
  return Bun.spawnSync(["bun", cliPath, "hook"], {
    // The child runs with this cwd; the situational `git-stash-u` guard
    // only fires when the working tree has uncommitted changes.
    cwd: dirtyCtx.cwd,
    env: { ...process.env, USERPROFILE: join(home, "user"), HOME: join(home, "user"), VIBEBLOAT_HOME: home, ...environment },
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function guard(id: string, command: string) {
  return {
    id, class: "A", provenance: { incident: "test", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command },
    action: { type: "block", message: `${id} is blocked.`, override: `vibebloat allow ${id} --once` }, enabled: true,
  };
}

test("hook loads a compiled guard from VIBEBLOAT_HOME", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-guards-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "no-publish.json"), JSON.stringify({
    id: "no-publish", class: "A", provenance: { incident: "test", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command: "npm publish" },
    action: { type: "block", message: "Publish is blocked.", override: "vibebloat allow no-publish --once" }, enabled: true,
  }));
  const result = runHook(home, { tool_input: { command: "npm publish" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("Publish is blocked.");
});

test("hook resolves a local Git alias before Class A evaluation", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-alias-"));
  tempDirectories.push(home);
  writeFileSync(join(home, ".gitconfig"), "[alias]\n  st = stash\n");
  const result = runHook(home, { tool_input: { command: "git st -u" } }, { HOME: home, USERPROFILE: home });

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("07-15 this deleted untracked files");
});

test("hook fails closed when an installed guard is invalid", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-guards-"));
  tempDirectories.push(home);
  mkdirSync(join(home, "guards"));
  writeFileSync(join(home, "guards", "broken.json"), "{");
  const result = runHook(home, { tool_input: { command: "echo safe" } });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe("WHAT failed: guard hook evaluation stopped.\nWHY: guard runtime could not load or evaluate installed guards.\nFIX: vibebloat doctor\n");
});

test("hook layers global and project guards when no home override is set", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-layered-"));
  tempDirectories.push(root);
  const project = join(root, "project"); const user = join(root, "user");
  mkdirSync(join(project, ".vibebloat", "guards"), { recursive: true });
  mkdirSync(join(user, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(project, ".vibebloat", "guards", "project.json"), JSON.stringify(guard("project-guard", "npm install")));
  writeFileSync(join(user, ".vibebloat", "guards", "global.json"), JSON.stringify(guard("global-guard", "npm publish")));
  const cli = join(import.meta.dir, "..", "src", "cli.ts");

  const projectResult = Bun.spawnSync(["bun", cli, "hook"], { cwd: project, env: { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined }, stdin: new Blob([JSON.stringify({ tool_input: { command: "npm install" } })]), stdout: "pipe", stderr: "pipe" });
  const globalResult = Bun.spawnSync(["bun", cli, "hook"], { cwd: project, env: { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined }, stdin: new Blob([JSON.stringify({ tool_input: { command: "npm publish" } })]), stdout: "pipe", stderr: "pipe" });
  expect(projectResult.exitCode).toBe(2);
  expect(globalResult.exitCode).toBe(2);
});

test("hook fails closed when global and project guards duplicate an id", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-duplicate-"));
  tempDirectories.push(root);
  const project = join(root, "project"); const user = join(root, "user");
  mkdirSync(join(project, ".vibebloat", "guards"), { recursive: true });
  mkdirSync(join(user, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(project, ".vibebloat", "guards", "project.json"), JSON.stringify(guard("duplicate", "npm install")));
  writeFileSync(join(user, ".vibebloat", "guards", "global.json"), JSON.stringify(guard("duplicate", "npm publish")));
  const result = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "hook"], { cwd: project, env: { ...process.env, USERPROFILE: user, VIBEBLOAT_HOME: undefined }, stdin: new Blob([JSON.stringify({ tool_input: { command: "echo safe" } })]), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe("WHAT failed: guard hook evaluation stopped.\nWHY: guard runtime could not load or evaluate installed guards.\nFIX: vibebloat doctor\n");
});

test("safe hook with default recall creates no SQLite database", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-no-recall-db-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  mkdirSync(project);

  const result = Bun.spawnSync(["bun", cliPath, "hook"], {
    cwd: project,
    env: { ...process.env, USERPROFILE: home, HOME: home, VIBEBLOAT_HOME: home },
    stdin: new Blob([JSON.stringify({ tool_input: { command: "echo safe" } })]),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(existsSync(defaultIncidentStorePath(project, globalGuardHome({ USERPROFILE: home })))).toBeFalse();
});

test("local recall hook prints exactly one advisory warning", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-local-recall-once-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const preload = join(root, "recall-hit.ts");
  mkdirSync(join(project, ".vibebloat"), { recursive: true });
  writeFileSync(join(project, ".vibebloat", "config.toml"), "[semantic]\nrecall = local\n");
  writeFileSync(preload, `
    import { LexicalRecall } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "src", "ingest", "recall-lexical.ts")).href)};
    import { LocalRecall } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "src", "ingest", "recall-local.ts")).href)};
    const hit = [{
      incidentId: "prior-stash",
      command: "git stash -u",
      condition: "untracked files disappeared",
      consequence: "manual restore was required",
      similarity: 1,
    }];
    LexicalRecall.prototype.recall = function () { return hit; };
    LocalRecall.prototype.recall = async function () { return hit; };
  `);

  const result = Bun.spawnSync(["bun", "--preload", preload, cliPath, "hook"], {
    cwd: project,
    env: { ...process.env, USERPROFILE: home, HOME: home, VIBEBLOAT_HOME: home },
    stdin: new Blob([JSON.stringify({ tool_input: { command: "git stash --include-untracked" } })]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const warningLines = result.stderr.toString().split(/\r?\n/).filter((line) => line.startsWith("Looks like the `git stash -u` mistake"));
  expect(result.exitCode).toBe(0);
  expect(warningLines).toHaveLength(1);
});

test("neural advisory closes once and a throwing close cannot kill the hook", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-recall-close-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  const lifecycleLog = join(root, "lifecycle.log");
  const preload = join(root, "throwing-close.ts");
  mkdirSync(join(project, ".vibebloat"), { recursive: true });
  writeFileSync(join(project, ".vibebloat", "config.toml"), "[semantic]\nrecall = local\n");
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    import { IncidentStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "src", "ingest", "incidents-store.ts")).href)};
    IncidentStore.prototype.isEmpty = function () {
      appendFileSync(process.env.VIBEBLOAT_RECALL_LIFECYCLE_LOG!, "use\\n");
      return true;
    };
    IncidentStore.prototype.close = function () {
      appendFileSync(process.env.VIBEBLOAT_RECALL_LIFECYCLE_LOG!, "close\\n");
      throw new Error("database is locked");
    };
  `);

  const result = Bun.spawnSync(["bun", "--preload", preload, cliPath, "hook"], {
    cwd: project,
    env: { ...process.env, USERPROFILE: home, HOME: home, VIBEBLOAT_HOME: home, VIBEBLOAT_RECALL_LIFECYCLE_LOG: lifecycleLog },
    stdin: new Blob([JSON.stringify({ tool_input: { command: "echo safe" } })]),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(lifecycleLog, "utf8")).toBe("use\nclose\n");
});
