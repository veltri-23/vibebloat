import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";
import type { Guard } from "../types";

export function installVerifiedGuard(directory: string, guard: Guard): void {
  const proofPath = join(directory, "proof.json");
  if (!existsSync(proofPath) || (JSON.parse(readFileSync(proofPath, "utf8")) as { status?: string }).status !== "pass") {
    throw new Error("Guard proof is required before install.");
  }
  replaceGuardAtomically(join(directory, `${guard.id}.json`), `${JSON.stringify(guard)}\n`);
}
