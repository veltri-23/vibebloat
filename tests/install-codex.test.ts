import { expect, test } from "bun:test";
import { withCodexPreToolUseHook } from "../src/install/codex";

test("Codex hook install preserves entries and avoids duplicate command", () => {
  const installed = withCodexPreToolUseHook({ hooks: { PreToolUse: [] } }, "vibebloat hook --agent=codex");
  expect(installed.hooks.PreToolUse[0]).toMatchObject({ matcher: "Bash|apply_patch" });
  expect(withCodexPreToolUseHook(installed, "vibebloat hook --agent=codex").hooks.PreToolUse).toHaveLength(1);
});
