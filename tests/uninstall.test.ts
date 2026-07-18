import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  uninstallVibeBloat,
  withoutClaudeHook,
  withoutCodexHook,
  withoutGitHook,
} from "../src/uninstall";
import { shellShimOwnershipLine } from "../src/install/shell-shim-ownership";
import { installGitShellShim } from "../src/install/shell-shim";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporary(): string {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-uninstall-"));
  directories.push(directory);
  return directory;
}

test("pure removers preserve unrelated Claude, Codex, and git-hook entries", () => {
  const claude = JSON.stringify({ theme: "light", hooks: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: "vibebloat hook" }, { type: "command", command: "keep claude" }] },
  ] } });
  expect(JSON.parse(withoutClaudeHook(claude))).toEqual({ theme: "light", hooks: { PreToolUse: [
    { matcher: "Bash", hooks: [{ type: "command", command: "keep claude" }] },
  ] } });

  const codex = `[features]\nplugin_hooks = true\n\n[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "vibebloat hook --agent=codex"\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "keep codex"\n`;
  const nextCodex = withoutCodexHook(codex);
  expect(nextCodex).toContain("plugin_hooks = true");
  expect(nextCodex).toContain('command = "keep codex"');
  expect(nextCodex).not.toContain("vibebloat hook --agent=codex");

  const hook = "#!/bin/sh\n# vibebloat:start\nvibebloat hook\n# vibebloat:end\necho keep\n";
  expect(withoutGitHook(hook)).toBe("#!/bin/sh\necho keep\n");
});

test("uninstall preflights every target and makes zero writes when one config is unsafe", () => {
  const root = temporary();
  const claude = join(root, "claude.json");
  const codex = join(root, "codex.toml");
  const originalClaude = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "vibebloat hook" }] }] } });
  writeFileSync(claude, originalClaude);
  writeFileSync(codex, 'command = "vibebloat hook --agent=codex"\n');

  expect(() => uninstallVibeBloat({ permitted: true, globalHome: join(root, "home"), claudePath: claude, codexPath: codex, doctor: () => "not-installed" }))
    .toThrow("WHAT failed: uninstall stopped.\nWHY: Codex VibeBloat command is outside an owned PreToolUse block; zero files changed.\nFIX: vibebloat doctor");
  expect(readFileSync(claude, "utf8")).toBe(originalClaude);
});

test("malformed Codex TOML fails closed before another config changes", () => {
  const root = temporary();
  const claude = join(root, "claude.json");
  const codex = join(root, "codex.toml");
  const originalClaude = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "vibebloat hook" }] }] } });
  writeFileSync(claude, originalClaude);
  writeFileSync(codex, '[features\nplugin_hooks = true\n');

  expect(() => uninstallVibeBloat({ permitted: true, globalHome: join(root, "home"), claudePath: claude, codexPath: codex, doctor: () => "not-installed" }))
    .toThrow("WHAT failed: uninstall stopped.\nWHY: Codex config is malformed TOML; zero files changed.\nFIX: vibebloat doctor");
  expect(readFileSync(claude, "utf8")).toBe(originalClaude);
});

test("Codex removal refuses user content added to an installer-shaped block", () => {
  const source = `[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch"\nuser_value = "keep"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "vibebloat hook --agent=codex"\n`;
  expect(() => withoutCodexHook(source)).toThrow("differs from the installer-owned shape");
});

test("uninstall removes owned integrations and data while preserving host entries", () => {
  const root = temporary();
  const globalHome = join(root, "home", ".vibebloat");
  const claude = join(root, "claude", "settings.json");
  const codex = join(root, "codex", "config.toml");
  const hermes = join(root, "hermes");
  const hook = join(root, "repo", ".git", "hooks", "pre-commit");
  const shim = join(root, "shim");
  const realGit = join(root, "bin", "git.exe");
  for (const directory of [dirname(claude), dirname(codex), hermes, dirname(hook), shim, dirname(realGit), join(globalHome, "guards"), join(globalHome, "audit", "firings"), join(globalHome, "cache", "retrieval")]) mkdirSync(directory, { recursive: true });
  writeFileSync(realGit, "git");
  writeFileSync(claude, JSON.stringify({ keep: true, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "vibebloat hook" }, { command: "keep" }] }] } }));
  writeFileSync(codex, `[features]\nplugin_hooks = true\n\n[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "vibebloat hook --agent=codex"\n\n[keep]\nvalue = true\n`);
  const handler = join(hermes, "hooks", "vibebloat", "handler.py");
  mkdirSync(dirname(handler), { recursive: true });
  writeFileSync(handler, "handler");
  const command = `"python" "${handler}" --vibebloat-handler-sha=abc`;
  writeFileSync(join(hermes, "config.yaml"), `model: keep\nhooks:\n  pre_tool_call:\n    # vibebloat-hermes-pre-tool-call\n    - command: '${command}'\n      matcher: '^(terminal)$'\n      timeout: 10\n`);
  writeFileSync(join(hermes, "shell-hooks-allowlist.json"), JSON.stringify({ keep: true, approvals: [{ event: "pre_tool_call", command: "keep" }, { event: "pre_tool_call", command }] }));
  writeFileSync(hook, "#!/bin/sh\n# vibebloat:start\nvibebloat hook\n# vibebloat:end\necho keep\n");
  writeFileSync(join(shim, "git"), `#!/bin/sh\n${shellShimOwnershipLine(realGit)}\nshim`);
  writeFileSync(join(shim, "git.cmd"), `@echo off\r\n${shellShimOwnershipLine(realGit, true)}\r\nshim`);
  writeFileSync(join(globalHome, "guards", "one.json"), "{}");
  writeFileSync(join(globalHome, "audit", "firings", "one.json"), "{}");
  writeFileSync(join(globalHome, "cache", "retrieval", "index.sqlite"), "cache");
  writeFileSync(join(globalHome, "email.json"), "{}");
  let registered = true;

  const result = uninstallVibeBloat({
    permitted: true,
    globalHome,
    claudePath: claude,
    codexPath: codex,
    hermesHome: hermes,
    shellShim: { directory: shim, realGitExecutable: realGit },
    gitHookPaths: [hook],
    openClaw: { isRegistered: () => registered, unregister: () => { registered = false; }, register: () => { registered = true; } },
    doctor: () => "not-installed",
  });

  expect(JSON.parse(readFileSync(claude, "utf8"))).toEqual({ keep: true, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "keep" }] }] } });
  expect(readFileSync(codex, "utf8")).toContain("[keep]\nvalue = true");
  expect(readFileSync(join(hermes, "config.yaml"), "utf8")).toContain("model: keep");
  expect(JSON.parse(readFileSync(join(hermes, "shell-hooks-allowlist.json"), "utf8"))).toEqual({ keep: true, approvals: [{ event: "pre_tool_call", command: "keep" }] });
  expect(readFileSync(hook, "utf8")).toBe("#!/bin/sh\necho keep\n");
  expect(existsSync(join(shim, "git"))).toBeFalse();
  expect(existsSync(join(shim, "git.cmd"))).toBeFalse();
  expect(existsSync(join(hermes, "hooks", "vibebloat"))).toBeFalse();
  expect(existsSync(globalHome)).toBeFalse();
  expect(registered).toBeFalse();
  expect(result.removed.length).toBeGreaterThan(0);
});

test("verification failure restores shared configs and leaves snapshots for recovery", () => {
  const root = temporary();
  const claude = join(root, "settings.json");
  const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "vibebloat hook" }] }] } });
  writeFileSync(claude, original);

  expect(() => uninstallVibeBloat({ permitted: true, globalHome: join(root, ".vibebloat"), claudePath: claude, doctor: () => "unhealthy" }))
    .toThrow("WHAT failed: uninstall stopped.\nWHY: vibebloat doctor did not report not installed.\nFIX: vibebloat doctor");
  expect(readFileSync(claude, "utf8")).toBe(original);
  expect(readdirSync(root).some((name) => name.includes("vibebloat-uninstall") && name.endsWith(".snapshot"))).toBeTrue();
});

test("doctor failure restores configs, shims, Hermes hook, data, project data, and OpenClaw", () => {
  const root = temporary();
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  const claude = join(root, "settings.json");
  const originalClaude = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "vibebloat hook" }] }] } });
  writeFileSync(claude, originalClaude);
  const realGit = join(root, "real-git.exe");
  const shimDirectory = join(root, "shim");
  writeFileSync(realGit, "git");
  installGitShellShim({ shimDirectory, runtimePath: join(root, "runtime.ts"), gitExecutable: realGit });
  const originalShim = readFileSync(join(shimDirectory, "git"), "utf8");
  const hermes = join(root, "hermes");
  const handler = join(hermes, "hooks", "vibebloat", "handler.py");
  mkdirSync(dirname(handler), { recursive: true });
  writeFileSync(handler, "handler");
  const command = `"python" "${handler}" --vibebloat-handler-sha=abc`;
  writeFileSync(join(hermes, "config.yaml"), `hooks:\n  pre_tool_call:\n    # vibebloat-hermes-pre-tool-call\n    - command: '${command}'\n      matcher: '^(terminal)$'\n      timeout: 10\n`);
  writeFileSync(join(hermes, "shell-hooks-allowlist.json"), JSON.stringify({ approvals: [{ event: "pre_tool_call", command }] }));
  const globalHome = join(root, "global");
  mkdirSync(join(globalHome, "audit"), { recursive: true });
  writeFileSync(join(globalHome, "audit", "event.json"), "{}");
  mkdirSync(join(root, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(root, ".vibebloat", "guards", "local.json"), "{}");
  let registered = true;

  expect(() => uninstallVibeBloat({
    permitted: true,
    globalHome,
    repository: root,
    claudePath: claude,
    hermesHome: hermes,
    shellShim: { directory: shimDirectory, realGitExecutable: realGit },
    openClaw: {
      isRegistered: () => registered,
      unregister: () => { registered = false; },
      register: () => { registered = true; },
    },
    doctor: () => "unhealthy",
  })).toThrow("vibebloat doctor did not report not installed");

  expect(readFileSync(claude, "utf8")).toBe(originalClaude);
  expect(readFileSync(join(shimDirectory, "git"), "utf8")).toBe(originalShim);
  expect(existsSync(handler)).toBeTrue();
  expect(existsSync(join(globalHome, "audit", "event.json"))).toBeTrue();
  expect(existsSync(join(root, ".vibebloat", "guards", "local.json"))).toBeTrue();
  expect(registered).toBeTrue();
});

test("uninstall accepts and removes freshly installed ownership-marked shims", () => {
  const root = temporary();
  const realGit = join(root, "real-git.exe");
  const shimDirectory = join(root, "shim");
  writeFileSync(realGit, "git");
  installGitShellShim({ shimDirectory, runtimePath: join(root, "runtime.ts"), gitExecutable: realGit });

  uninstallVibeBloat({
    permitted: true,
    globalHome: join(root, "global"),
    shellShim: { directory: shimDirectory, realGitExecutable: realGit },
    doctor: () => "not-installed",
  });
  expect(existsSync(join(shimDirectory, "git"))).toBeFalse();
  expect(existsSync(join(shimDirectory, "git.cmd"))).toBeFalse();
});

test("OpenClaw unregister failure after mutation restores registration", () => {
  const root = temporary();
  let registered = true;
  expect(() => uninstallVibeBloat({
    permitted: true,
    globalHome: join(root, "global"),
    openClaw: {
      isRegistered: () => registered,
      unregister: () => { registered = false; throw new Error("host failed after mutation"); },
      register: () => { registered = true; },
    },
    doctor: () => "not-installed",
  })).toThrow("uninstall mutation or verification failed");
  expect(registered).toBeTrue();
});

test("keep-data preserves machine data while uninstall remains idempotent", () => {
  const root = temporary();
  const home = join(root, ".vibebloat");
  mkdirSync(join(home, "audit", "firings"), { recursive: true });
  writeFileSync(join(home, "audit", "firings", "one.json"), "{}");
  const options = { permitted: true, keepData: true, globalHome: home, doctor: () => "not-installed" as const };
  expect(uninstallVibeBloat(options).preserved).toContain(home);
  expect(uninstallVibeBloat(options).preserved).toContain(home);
  expect(existsSync(join(home, "audit", "firings", "one.json"))).toBeTrue();
});

test("tracked repository guards are reported and preserved", () => {
  const root = temporary();
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  const projectHome = join(root, ".vibebloat");
  mkdirSync(join(projectHome, "guards"), { recursive: true });
  writeFileSync(join(projectHome, "guards", "tracked.json"), "{}");
  Bun.spawnSync(["git", "add", ".vibebloat/guards/tracked.json"], { cwd: root });

  const result = uninstallVibeBloat({ permitted: true, globalHome: join(root, "global"), repository: root, doctor: () => "not-installed" });
  expect(existsSync(join(projectHome, "guards", "tracked.json"))).toBeTrue();
  expect(result.preserved).toContain(join(root, ".vibebloat/guards/tracked.json"));
});

test("untracked repository data is removed only with explicit permission", () => {
  const root = temporary();
  Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  mkdirSync(join(root, ".vibebloat", "guards"), { recursive: true });
  writeFileSync(join(root, ".vibebloat", "guards", "local.json"), "{}");

  expect(() => uninstallVibeBloat({ permitted: false, globalHome: join(root, "global"), repository: root, doctor: () => "not-installed" })).toThrow("--yes");
  expect(existsSync(join(root, ".vibebloat", "guards", "local.json"))).toBeTrue();
  uninstallVibeBloat({ permitted: true, globalHome: join(root, "global"), repository: root, doctor: () => "not-installed" });
  expect(existsSync(join(root, ".vibebloat"))).toBeFalse();
});

test("uninstall refuses to orphan a persistent filesystem guard", () => {
  const root = temporary();
  const receipt = join(root, ".vibebloat", "receipts", "fs-guard.json");
  mkdirSync(dirname(receipt), { recursive: true });
  writeFileSync(receipt, "{}");

  expect(() => uninstallVibeBloat({ permitted: true, globalHome: join(root, "global"), repository: root, doctor: () => "not-installed" }))
    .toThrow("exact process rollback is unavailable; zero files changed");
  expect(existsSync(receipt)).toBeTrue();
});
