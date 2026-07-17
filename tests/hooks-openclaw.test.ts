import { expect, test } from "bun:test";
import openClawPlugin, { beforeToolCall } from "../src/hooks/openclaw-plugin";
import { gitStashUntrackedGuard } from "../src/guards";
import type { Guard } from "../src/types";

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
