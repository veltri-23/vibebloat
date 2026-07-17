import { writeFileSync } from "node:fs";
import { createRollback, rollback } from "./rollback";

export function applyUpdate(binaryPath: string, binary: string | Uint8Array, doctor: () => boolean): void {
  const backup = createRollback(binaryPath);
  writeFileSync(binaryPath, binary);
  if (doctor()) return;
  rollback(binaryPath, backup);
  throw new Error("Update rolled back because doctor failed.");
}
