import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export interface AtomicFilePlan {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

interface Snapshot {
  existed: boolean;
  content?: Buffer;
  mode?: number;
}

function temporaryPath(path: string): string {
  return `${path}.${randomUUID()}.vibebloat-tmp`;
}

function writeReplacement(plan: AtomicFilePlan, temporary: string): void {
  mkdirSync(dirname(plan.path), { recursive: true });
  writeFileSync(temporary, plan.content);
  if (plan.mode !== undefined) chmodSync(temporary, plan.mode);
}

function restore(path: string, snapshot: Snapshot): void {
  if (!snapshot.existed) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = temporaryPath(path);
  try {
    writeFileSync(temporary, snapshot.content!);
    if (snapshot.mode !== undefined) chmodSync(temporary, snapshot.mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function applyAtomicFilePlans(plans: readonly AtomicFilePlan[]): void {
  const normalized = plans.map((plan) => ({ ...plan, path: resolve(plan.path) }));
  if (new Set(normalized.map((plan) => plan.path)).size !== normalized.length) {
    throw new Error("Atomic install plan contains duplicate target paths.");
  }
  for (const plan of normalized) {
    if (existsSync(plan.path) && lstatSync(plan.path).isSymbolicLink()) {
      throw new Error(`Refusing to replace symbolic link: ${plan.path}`);
    }
  }

  const snapshots = new Map<string, Snapshot>();
  const temporaries = new Map<string, string>();
  try {
    for (const plan of normalized) {
      snapshots.set(plan.path, existsSync(plan.path)
        ? { existed: true, content: readFileSync(plan.path), mode: lstatSync(plan.path).mode }
        : { existed: false });
      const temporary = temporaryPath(plan.path);
      temporaries.set(plan.path, temporary);
      writeReplacement(plan, temporary);
    }
  } catch (error) {
    for (const temporary of temporaries.values()) rmSync(temporary, { force: true });
    throw error;
  }

  const applied: string[] = [];
  try {
    for (const plan of normalized) {
      renameSync(temporaries.get(plan.path)!, plan.path);
      applied.push(plan.path);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const path of applied.reverse()) {
      try {
        restore(path, snapshots.get(path)!);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`Install mutation failed and rollback was incomplete: ${rollbackErrors.join("; ")}`, { cause: error });
    }
    throw error;
  } finally {
    for (const temporary of temporaries.values()) rmSync(temporary, { force: true });
  }
}
