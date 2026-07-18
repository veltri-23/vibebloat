import { existsSync, readFileSync, writeFileSync } from "node:fs";

const start = "# vibebloat:start";
const end = "# vibebloat:end";

export function installGitHook(hookPath: string, command: string): void {
  const existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : "#!/bin/sh\n";
  if (existing.includes(start)) return;
  const block = `${start}\n${command}\n${end}\n`;
  const shebangEnd = existing.startsWith("#!") ? existing.indexOf("\n") + 1 : 0;
  const insertion = shebangEnd > 0 ? shebangEnd : 0;
  const suffix = existing.slice(insertion);
  writeFileSync(hookPath, `${existing.slice(0, insertion)}${block}${suffix}`);
}
