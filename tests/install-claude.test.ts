import { expect, test } from "bun:test";
import { withClaudePreToolUseHook } from "../src/install/claude";

test("Claude hook install preserves existing settings and adds VibeBloat once", () => {
  const existingHook = { matcher: "Bash", hooks: [{ type: "command" as const, command: "existing hook" }] };
  const existing = { permissions: { allow: ["Read"] }, hooks: { PreToolUse: [existingHook] } };
  const installed = withClaudePreToolUseHook(existing, "vibebloat hook");
  expect(installed.permissions).toEqual({ allow: ["Read"] });
  expect(installed.hooks.PreToolUse?.map((entry) => entry.hooks[0].command)).toEqual(["vibebloat hook", "existing hook"]);
  expect(withClaudePreToolUseHook(installed, "vibebloat hook").hooks.PreToolUse).toHaveLength(2);
});
