export interface CodexHooksConfig {
  hooks?: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }> };
}

export function withCodexPreToolUseHook(config: CodexHooksConfig, command: string): Required<CodexHooksConfig> {
  const preToolUse = config.hooks?.PreToolUse ?? [];
  if (preToolUse.some((entry) => entry.hooks.some((hook) => hook.command === command))) return { hooks: { PreToolUse: preToolUse } };
  return { hooks: { PreToolUse: [...preToolUse, { matcher: "Bash|apply_patch", hooks: [{ type: "command", command }] }] } };
}
