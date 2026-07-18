function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function featureSection(config: string): [number, number] | undefined {
  const start = config.search(/^\[features\]\s*$/m);
  if (start < 0) return undefined;
  const afterHeader = config.indexOf("\n", start) + 1;
  const nextSection = config.slice(afterHeader).search(/^\[/m);
  return [afterHeader, nextSection < 0 ? config.length : afterHeader + nextSection];
}

export function withCodexPreToolUseHook(config: string, command: string): string {
  let next = config;
  const section = featureSection(next);
  if (!section) {
    next = `${next.trimEnd()}\n\n[features]\nplugin_hooks = true\n`;
  } else {
    const [start, end] = section;
    const body = next.slice(start, end);
    const updated = /^plugin_hooks\s*=.*$/m.test(body)
      ? body.replace(/^plugin_hooks\s*=.*$/m, "plugin_hooks = true")
      : `${body.trimEnd()}\nplugin_hooks = true\n`;
    next = `${next.slice(0, start)}${updated}${next.slice(end)}`;
  }

  const encodedCommand = tomlString(command);
  if (next.includes(`command = ${encodedCommand}`)) return next;
  const hook = `[[hooks.PreToolUse]]\nmatcher = "Bash|apply_patch"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = ${encodedCommand}\n\n`;
  const firstHook = next.search(/^\[\[hooks\.PreToolUse\]\]\s*$/m);
  return firstHook < 0
    ? `${next.trimEnd()}\n\n${hook.trimEnd()}\n`
    : `${next.slice(0, firstHook)}${hook}${next.slice(firstHook)}`;
}
