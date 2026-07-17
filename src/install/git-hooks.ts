import { existsSync, readFileSync, writeFileSync } from "node:fs";

const start = "# vibebloat:start";
const end = "# vibebloat:end";

export function installGitHook(hookPath: string, command: string): void {
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "#!/bin/sh\n";
  if (existing.includes(start)) return;
  const separator = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(hookPath, `${existing}${separator}${start}\n${command}\n${end}\n`);
}
