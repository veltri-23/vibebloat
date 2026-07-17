import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";

export function writeCheckpoint(directory: string, stage: string, value: unknown): void {
  replaceGuardAtomically(join(directory, `${stage}.json`), `${JSON.stringify(value)}\n`);
}

export function readCheckpoint<T>(directory: string, stage: string): T | undefined {
  const path = join(directory, `${stage}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined;
}
