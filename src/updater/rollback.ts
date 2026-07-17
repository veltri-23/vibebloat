import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export function createRollback(binaryPath: string): string {
  const backup = join(dirname(binaryPath), `.${randomUUID()}.rollback`);
  copyFileSync(binaryPath, backup);
  return backup;
}

export function rollback(binaryPath: string, backupPath: string): void {
  copyFileSync(backupPath, binaryPath);
}
