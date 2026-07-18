import { copyFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function createRollback(binaryPath: string): string {
  const backup = join(dirname(binaryPath), `.${randomUUID()}.rollback`);
  copyFileSync(binaryPath, backup);
  return backup;
}

export function rollback(binaryPath: string, backupPath: string): void {
  const temporaryPath = join(dirname(binaryPath), `.${randomUUID()}.rollback-restore`);
  try {
    copyFileSync(backupPath, temporaryPath);
    renameSync(temporaryPath, binaryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}
