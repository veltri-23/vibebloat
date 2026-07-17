import { mkdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function replaceGuardAtomically(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, content);
  renameSync(temporaryPath, path);
}

export function guardWatchPath(directory: string, filename: string | Buffer | null): string | undefined {
  if (!filename || !filename.toString().endsWith(".json")) return undefined;
  return join(directory, filename.toString());
}

export function watchGuardDirectory(directory: string, onChange: (path: string) => void): FSWatcher {
  return watch(directory, { persistent: false }, (_eventType, filename) => {
    const path = guardWatchPath(directory, filename);
    if (path) onChange(path);
  });
}
