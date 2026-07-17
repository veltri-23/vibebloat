export interface ClaudeSettings {
  hooks?: { PreToolUse?: Array<{ matcher: string; hooks: Array<{ type: "command"; command: string }> }> };
  [key: string]: unknown;
}

export function withClaudePreToolUseHook(settings: ClaudeSettings, command: string): ClaudeSettings {
  const preToolUse = settings.hooks?.PreToolUse ?? [];
  if (preToolUse.some((entry) => entry.hooks.some((hook) => hook.command === command))) return settings;
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      PreToolUse: [...preToolUse, { matcher: "Bash|Write|Edit", hooks: [{ type: "command", command }] }],
    },
  };
}
