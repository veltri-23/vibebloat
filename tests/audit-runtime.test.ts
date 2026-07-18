import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAndPruneFirings, type FiringMetadata } from "../src/audit/firings";
import { gitStashUntrackedGuard } from "../src/guards";
import { runPreToolUse } from "../src/hooks";
import { guardedBeforeToolCall } from "../src/hooks/openclaw-plugin";
import { Runtime } from "../src/runtime";

const temporaryDirectories: string[] = [];
const repositoryRoot = join(import.meta.dir, "..");
const cliPath = join(repositoryRoot, "src", "cli.ts");
const auditWarning = "WHAT failed: firing audit update stopped.\nWHY: local firing audit storage or retention failed.\nFIX: vibebloat doctor";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-audit-runtime-"));
  temporaryDirectories.push(root);
  return root;
}

test("runtime firing callback receives closed metadata only and skips non-firings", () => {
  const received: FiringMetadata[] = [];
  const runtime = new Runtime([], undefined, (event) => event, (event) => { received.push(event); });
  const secretGuard = {
    ...gitStashUntrackedGuard,
    provenance: { ...gitStashUntrackedGuard.provenance, incident: "Bearer incident-secret" },
    action: { ...gitStashUntrackedGuard.action, message: "Bearer message-secret" },
  };

  expect(runtime.evaluate([secretGuard], { chokepoint: "shell", command: "git stash -u Bearer command-secret" }, { agent: "codex" })).toMatchObject({ fired: true, blocked: true });
  expect(runtime.evaluate([secretGuard], { chokepoint: "shell", command: "git status" }, { agent: "codex" })).toEqual({ fired: false });
  expect(received).toEqual([{
    guardId: "git-stash-u",
    class: "A",
    chokepoint: "shell",
    actionType: "block",
    blocked: true,
    agent: "codex",
  }]);
  expect(JSON.stringify(received)).not.toMatch(/command-secret|message-secret|incident-secret|Bearer/i);
});

test("audit callback failure preserves block receipt and returns a separate three-line warning", () => {
  const runtime = new Runtime([], undefined, (event) => event, () => { throw new Error("C:\\private\\Bearer secret"); });
  const response = runPreToolUse([gitStashUntrackedGuard], { tool_input: { command: "git stash -u Bearer secret" } }, runtime, "claude-code");

  expect(response).toMatchObject({ exitCode: 2, stderr: expect.stringContaining("BLOCKED  guard: git-stash-u  class: A"), localWarning: auditWarning });
  expect(String(response.stderr ?? "").includes("Bearer secret")).toBeFalse();
  expect(response.localWarning).not.toMatch(/private|Bearer/i);
});

test("Claude, Codex, and Hermes CLI hooks append agent-only firing metadata", () => {
  const root = temporaryRoot();
  const user = join(root, "user");
  const guardHome = join(root, "guards");
  const environment = { ...process.env, USERPROFILE: user, HOME: user, VIBEBLOAT_HOME: guardHome };
  for (const argument of [undefined, "--agent=codex", "--agent=hermes"]) {
    const result = Bun.spawnSync(["bun", cliPath, "hook", ...(argument ? [argument] : [])], {
      cwd: repositoryRoot,
      env: environment,
      stdin: new Blob([JSON.stringify({ tool_input: { command: "git stash -u" } })]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(argument === "--agent=codex" ? 0 : 2);
  }

  expect(readAndPruneFirings(join(user, ".vibebloat")).events.map((event) => event.agent).sort()).toEqual(["claude-code", "codex", "hermes"]);
}, 60_000);

test("OpenClaw appends through its native transport", () => {
  const root = temporaryRoot();
  const openClawUser = join(root, "openclaw-user");
  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "git stash -u" } },
    { USERPROFILE: openClawUser, HOME: openClawUser },
    root,
  )).toMatchObject({ block: true, blockReason: gitStashUntrackedGuard.action.message });
  expect(readAndPruneFirings(join(openClawUser, ".vibebloat")).events.map((event) => event.agent)).toEqual(["openclaw"]);
});

test("shell shim appends through its native transport", () => {
  const root = temporaryRoot();
  const shellUser = join(root, "shell-user");
  const gitExecutable = Bun.which("git");
  expect(gitExecutable).toBeTruthy();
  const shell = Bun.spawnSync(["bun", join(repositoryRoot, "src", "hooks", "shell-shim-cli.ts"), gitExecutable!, "stash", "-u"], {
    cwd: root,
    env: { ...process.env, USERPROFILE: shellUser, HOME: shellUser, VIBEBLOAT_HOME: join(root, "shell-guards") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(shell.exitCode).toBe(2);
  const shellEvents = readAndPruneFirings(join(shellUser, ".vibebloat")).events;
  expect(shellEvents).toHaveLength(1);
  expect("agent" in shellEvents[0]!).toBeFalse();
}, 30_000);

test("CLI audit write failure never weakens enforcement or leaks its path", () => {
  const root = temporaryRoot();
  const invalidUserHome = join(root, "not-a-directory");
  writeFileSync(invalidUserHome, "file blocks global audit home");
  const result = Bun.spawnSync(["bun", cliPath, "hook"], {
    cwd: repositoryRoot,
    env: { ...process.env, USERPROFILE: invalidUserHome, HOME: invalidUserHome, VIBEBLOAT_HOME: join(root, "guards") },
    stdin: new Blob([JSON.stringify({ tool_input: { command: "git stash -u" } })]),
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("BLOCKED  guard: git-stash-u  class: A\n");
  expect(result.stderr.toString()).toEndWith(`${auditWarning}\n`);
  expect(result.stderr.toString()).not.toContain(invalidUserHome);
});

test("shell runtime failure uses exact three-line fail-closed output", () => {
  const root = temporaryRoot();
  const guardHome = join(root, "guard-home");
  mkdirSync(join(guardHome, "guards"), { recursive: true });
  writeFileSync(join(guardHome, "guards", "broken.json"), "{");
  const gitExecutable = Bun.which("git");
  expect(gitExecutable).toBeTruthy();
  const result = Bun.spawnSync(["bun", join(repositoryRoot, "src", "hooks", "shell-shim-cli.ts"), gitExecutable!, "status"], {
    cwd: root,
    env: { ...process.env, USERPROFILE: join(root, "user"), HOME: join(root, "user"), VIBEBLOAT_HOME: guardHome },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toBe("WHAT failed: shell guard evaluation stopped.\nWHY: guard runtime could not load or evaluate installed guards.\nFIX: vibebloat doctor\n");
});
