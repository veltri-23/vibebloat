import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";

export type CheckpointRead<T> =
  | { status: "missing" }
  | { status: "valid"; value: T }
  | { status: "legacy" };

function checkpointPath(directory: string, stage: string): string {
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error("Checkpoint stage must be a simple identifier");
  return join(directory, `${stage}.json`);
}

export function writeCheckpoint(directory: string, stage: string, value: unknown): void {
  replaceGuardAtomically(checkpointPath(directory, stage), `${JSON.stringify(value)}\n`);
}

export function readCheckpoint<T>(directory: string, stage: string): T | undefined {
  const path = checkpointPath(directory, stage);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : undefined;
}

export function readValidatedCheckpoint<T>(directory: string, stage: string, validate: (value: unknown) => value is T): CheckpointRead<T> {
  const path = checkpointPath(directory, stage);
  if (!existsSync(path)) return { status: "missing" };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return validate(value) ? { status: "valid", value } : { status: "legacy" };
  } catch {
    return { status: "legacy" };
  }
}
