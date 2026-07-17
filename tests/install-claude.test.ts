import { expect, test } from "bun:test";
import { withClaudePreToolUseHook } from "../src/install/claude";

test("Claude hook install preserves existing settings and adds VibeBloat once", () => {
  const existing = { permissions: { allow: ["Read"] }, hooks: { PreToolUse: [] } };
  const installed = withClaudePreToolUseHook(existing, "vibebloat hook");
  expect(installed.permissions).toEqual({ allow: ["Read"] });
  expect(installed.hooks.PreToolUse).toHaveLength(1);
  expect(withClaudePreToolUseHook(installed, "vibebloat hook").hooks.PreToolUse).toHaveLength(1);
});
