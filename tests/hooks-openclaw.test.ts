import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import openClawPlugin, { beforeToolCall, guardedBeforeToolCall } from "../src/hooks/openclaw-plugin";
import { gitStashUntrackedGuard } from "../src/guards";
import type { Guard } from "../src/types";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function compiledGuard(id: string, command: string) {
  return {
    id,
    class: "A",
    provenance: { incident: "test", date: "2026-07-18", source: "test" },
    match: { chokepoint: "shell", command },
    action: { type: "block", message: `${id} is blocked.`, override: `vibebloat allow ${id} --once` },
    enabled: true,
  };
}

test("OpenClaw native hook blocks the shared Class A guard", () => {
  expect(beforeToolCall([gitStashUntrackedGuard], {
    toolName: "exec",
    params: { command: "git stash -u" },
  })).toMatchObject({ block: true, blockReason: gitStashUntrackedGuard.action.message });
});

test("OpenClaw maps require-confirm to its native approval UI", () => {
  const guard: Guard = {
    ...gitStashUntrackedGuard,
    action: { type: "require-confirm", message: "Confirm stash", override: "allow once" },
  };
  expect(beforeToolCall([guard], {
    toolName: "exec",
    params: { command: "git stash -u" },
  })).toMatchObject({
    requireApproval: { title: "VibeBloat confirmation", timeoutBehavior: "deny" },
  });
});

test("OpenClaw entry registers a before_tool_call hook", () => {
  let name = "";
  openClawPlugin.register({ on(hookName) { name = hookName; } });
  expect(name).toBe("before_tool_call");
});

test("OpenClaw blocks a learned project guard", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-openclaw-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const user = join(root, "user");
  const guards = join(project, ".vibebloat", "guards");
  mkdirSync(guards, { recursive: true });
  writeFileSync(join(guards, "no-publish.json"), JSON.stringify(compiledGuard("no-publish", "npm publish")));

  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "npm publish" } },
    { USERPROFILE: user },
    project,
  )).toMatchObject({ block: true, blockReason: "no-publish is blocked." });
});

test("OpenClaw resolves repository Git aliases before Class A evaluation", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-openclaw-alias-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const user = join(root, "user");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, ".git", "config"), "[alias]\n  st = stash\n");

  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "git st -u" } },
    { HOME: user, USERPROFILE: user },
    project,
  )).toMatchObject({ block: true, blockReason: gitStashUntrackedGuard.action.message });
});

test("OpenClaw fails closed when compiled guard loading fails", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-openclaw-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const user = join(root, "user");
  const guards = join(project, ".vibebloat", "guards");
  mkdirSync(guards, { recursive: true });
  writeFileSync(join(guards, "broken.json"), "{");

  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "echo safe" } },
    { USERPROFILE: user },
    project,
  )).toMatchObject({ block: true, blockReason: expect.stringContaining("Guard runtime failed closed") });
});

test("OpenClaw fails closed when compiled guard ids duplicate", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-openclaw-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const user = join(root, "user");
  const globalGuards = join(user, ".vibebloat", "guards");
  const projectGuards = join(project, ".vibebloat", "guards");
  mkdirSync(globalGuards, { recursive: true });
  mkdirSync(projectGuards, { recursive: true });
  writeFileSync(join(globalGuards, "global.json"), JSON.stringify(compiledGuard("duplicate", "npm publish")));
  writeFileSync(join(projectGuards, "project.json"), JSON.stringify(compiledGuard("duplicate", "npm install")));

  expect(guardedBeforeToolCall(
    { toolName: "exec", params: { command: "echo safe" } },
    { USERPROFILE: user },
    project,
  )).toMatchObject({ block: true, blockReason: expect.stringContaining("duplicates built-in id: duplicate") });
});
