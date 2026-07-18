import { expect, test } from "bun:test";
import { withCodexPreToolUseHook } from "../src/install/codex";

test("Codex hook install enables plugin hooks and preserves config", () => {
  const installed = withCodexPreToolUseHook('model = "terra"\n\n[features]\njs_repl = false\n', "vibebloat hook --agent=codex");
  expect(installed).toContain('model = "terra"');
  expect(installed).toContain("plugin_hooks = true");
  expect(installed).toContain('[[hooks.PreToolUse]]');
  expect(installed).toContain('command = "vibebloat hook --agent=codex"');
  expect(withCodexPreToolUseHook(installed, "vibebloat hook --agent=codex").match(/command = "vibebloat hook --agent=codex"/g)).toHaveLength(1);
});

test("Codex hook install creates missing feature section", () => {
  const installed = withCodexPreToolUseHook("model = \"terra\"\n", "C:\\Tools\\vibebloat hook --agent=codex");
  expect(installed).toContain("[features]\nplugin_hooks = true");
  expect(installed).toContain('command = "C:\\\\Tools\\\\vibebloat hook --agent=codex"');
});

test("Codex installs VibeBloat before an existing PreToolUse chain", () => {
  const existing = '[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "existing hook"\n';
  const installed = withCodexPreToolUseHook(existing, "vibebloat hook --agent=codex");

  expect(installed.indexOf('command = "vibebloat hook --agent=codex"')).toBeLessThan(installed.indexOf('command = "existing hook"'));
});
