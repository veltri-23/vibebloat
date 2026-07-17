import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function statePath(home: string): string {
  return join(home, "disabled.json");
}

export function disabledGuardIds(home = process.env.VIBEBLOAT_HOME ?? join(homedir(), ".vibebloat")): Set<string> {
  const path = statePath(home);
  if (!existsSync(path)) return new Set();
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) throw new Error("Disabled guard state is invalid.");
  return new Set(value);
}

export function disableGuard(guardId: string, home = process.env.VIBEBLOAT_HOME ?? join(homedir(), ".vibebloat")): void {
  if (!guardId) throw new Error("Guard id is required.");
  mkdirSync(home, { recursive: true });
  const disabled = disabledGuardIds(home);
  disabled.add(guardId);
  const path = statePath(home);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify([...disabled].sort())}\n`);
  renameSync(temporaryPath, path);
}
