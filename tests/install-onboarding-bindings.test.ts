import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { installOnboardingBindings, type OnboardingBindingInstallOptions } from "../src/install/onboarding-bindings";

const temporaryDirectories: string[] = [];
const pythonExecutable = Bun.which("python") ?? Bun.which("python3");
const gitExecutable = Bun.which("git");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { root: string; repository: string; claudePath: string; codexPath: string } {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-bindings-"));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  mkdirSync(repository);
  expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repository }).exitCode).toBe(0);
  return {
    root,
    repository,
    claudePath: join(root, "claude", "settings.json"),
    codexPath: join(root, "codex", "config.toml"),
  };
}

function options(value: ReturnType<typeof setup>, environmentIds: string[]): OnboardingBindingInstallOptions {
  return {
    permitted: true,
    environmentIds,
    repository: value.repository,
    command: "vibebloat hook",
    gitCommands: {
      "pre-commit": "vibebloat git-hook pre-commit",
      "pre-push": "vibebloat git-hook pre-push",
    },
    claudePath: value.claudePath,
    codexPath: value.codexPath,
    now: new Date("2026-07-18T12:00:00.000Z"),
  };
}

test("selected Claude and Codex hooks plus Git baseline are exactly verified and safely receipted", () => {
  const value = setup();
  const receipt = installOnboardingBindings(options(value, ["codex", "claude-code"]));

  expect(readFileSync(value.claudePath, "utf8")).toContain('"command": "vibebloat hook"');
  expect(readFileSync(value.codexPath, "utf8")).toContain('command = "vibebloat hook --agent=codex"');
  expect(readFileSync(join(value.repository, ".git", "hooks", "pre-commit"), "utf8"))
    .toContain("# vibebloat:start\nvibebloat git-hook pre-commit\n# vibebloat:end\n");
  expect(receipt).toEqual({
    schemaVersion: 1,
    owner: "vibebloat",
    kind: "onboarding-bindings",
    environments: [
      { id: "claude-code", mechanism: "claude-pre-tool-use" },
      { id: "codex", mechanism: "codex-pre-tool-use" },
    ],
    gitBaseline: "verified",
    verifiedAt: "2026-07-18T12:00:00.000Z",
  });
  const persisted = readFileSync(join(value.repository, ".vibebloat", "receipts", "onboarding-bindings.json"), "utf8");
  expect(JSON.parse(persisted)).toEqual(receipt);
  expect(persisted).not.toContain(value.root);
  expect(persisted).not.toContain("vibebloat hook");
});

test("selection does not write an unselected native agent config", () => {
  const value = setup();
  const receipt = installOnboardingBindings(options(value, ["claude-code"]));

  expect(existsSync(value.claudePath)).toBeTrue();
  expect(existsSync(value.codexPath)).toBeFalse();
  expect(receipt.environments).toEqual([{ id: "claude-code", mechanism: "claude-pre-tool-use" }]);
});

test("Hermes selection fails before baseline mutation without explicit native paths", () => {
  const value = setup();
  const request = options(value, ["claude-code", "hermes"]);
  delete request.hermes;

  expect(() => installOnboardingBindings(request)).toThrow("explicit home and Python paths");
  expect(existsSync(value.claudePath)).toBeFalse();
  expect(existsSync(join(value.repository, ".git", "hooks", "pre-commit"))).toBeFalse();
});

if (pythonExecutable) test("Hermes selection installs digest-bound handler, config, and allowlist evidence", () => {
  const value = setup();
  const hermesHome = join(value.root, "hermes");
  mkdirSync(hermesHome);
  const request = options(value, ["hermes"]);
  request.hermes = { hermesHome, pythonExecutable };
  const receipt = installOnboardingBindings(request);

  const handler = join(hermesHome, "hooks", "vibebloat", "handler.py");
  const digest = createHash("sha256").update(readFileSync(handler)).digest("hex");
  const config = readFileSync(join(hermesHome, "config.yaml"), "utf8");
  const allowlist = readFileSync(join(hermesHome, "shell-hooks-allowlist.json"), "utf8");
  expect(config).toContain(`--vibebloat-handler-sha=${digest}`);
  expect(allowlist).toContain(`--vibebloat-handler-sha=${digest}`);
  expect(receipt.environments).toEqual([{ id: "hermes", mechanism: "hermes-digest-bound-hook" }]);
  expect(JSON.stringify(receipt)).not.toContain(hermesHome);
});

test("OpenClaw selection requires host registration and ignores ambient session claims", () => {
  const value = setup();
  const request = options(value, ["openclaw"]);
  const original = process.env.OPENCLAW_SESSION;
  process.env.OPENCLAW_SESSION = "untrusted-session-claim";
  try {
    expect(() => installOnboardingBindings(request)).toThrow("host did not verify");
    expect(existsSync(join(value.repository, ".git", "hooks", "pre-commit"))).toBeFalse();
  } finally {
    if (original === undefined) delete process.env.OPENCLAW_SESSION;
    else process.env.OPENCLAW_SESSION = original;
  }

  let checks = 0;
  request.verifyOpenClawRegistration = (pluginId) => { checks += 1; return pluginId === "vibebloat"; };
  const receipt = installOnboardingBindings(request);
  expect(checks).toBe(2);
  expect(receipt.environments).toEqual([{ id: "openclaw", mechanism: "openclaw-host-registration" }]);
});

test("unknown environment requires verified shell and filesystem fallback evidence", () => {
  if (!gitExecutable) throw new Error("Git is required for fallback binding tests.");
  const value = setup();
  const request = options(value, ["cursor"]);
  expect(() => installOnboardingBindings(request)).toThrow("require verified shell and filesystem fallback");

  const shimDirectory = join(value.root, "shim");
  const posixShim = process.platform === "win32"
    ? shimDirectory.replace(/^([A-Za-z]):[\\/](.*)$/, (_match, drive, path) => `/${drive.toLowerCase()}/${path.replaceAll("\\", "/")}`)
    : shimDirectory;
  request.fallback = {
    shimDirectory,
    gitExecutable,
    readPath: (shell) => shell === "pwsh" ? `${shimDirectory};C:/Windows` : `${posixShim}:/usr/bin`,
    selfCommand: [process.execPath, join(import.meta.dir, "../src/cli.ts")],
    fsGuardCommand: [process.execPath, "watch", join(value.root, "wrong-repository")],
    spawnFsGuard: () => ({ pid: 4242, unref() {}, kill() {} }),
    probeFsGuard: () => "owned",
    instanceId: randomUUID(),
    now: new Date("2026-07-18T12:00:00.000Z"),
  };
  expect(() => installOnboardingBindings(request)).toThrow("explicit repository path");
  expect(existsSync(join(value.repository, ".git", "hooks", "pre-commit"))).toBeFalse();
  request.fallback.fsGuardCommand = [process.execPath, "watch", resolve(value.repository)];
  const receipt = installOnboardingBindings(request);

  expect(existsSync(join(shimDirectory, "git"))).toBeTrue();
  expect(existsSync(join(shimDirectory, "git.cmd"))).toBeTrue();
  expect(existsSync(join(value.repository, ".vibebloat", "receipts", "fs-guard.json"))).toBeTrue();
  expect(receipt.environments).toEqual([{ id: "cursor", mechanism: "shell-git-fs-fallback" }]);
  expect(JSON.stringify(receipt)).not.toContain(value.root);
});

test("unsafe or duplicate discovery identifiers fail before any write", () => {
  for (const environmentIds of [["codex", "codex"], ["../../escape"]]) {
    const value = setup();
    expect(() => installOnboardingBindings(options(value, environmentIds))).toThrow();
    expect(existsSync(value.codexPath)).toBeFalse();
    expect(existsSync(join(value.repository, ".git", "hooks", "pre-commit"))).toBeFalse();
  }
});
