import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { parseGuard } from "../schema";
import type { Guard } from "../types";

export function installVerifiedGuard(directory: string, guard: Guard): void {
  const validatedGuard = parseGuard(guard);
  const proofPath = join(directory, "proof.json");
  if (!existsSync(proofPath) || (JSON.parse(readFileSync(proofPath, "utf8")) as { status?: string }).status !== "pass") {
    throw new Error("Guard proof is required before install.");
  }
  replaceGuardAtomically(join(directory, `${validatedGuard.id}.json`), `${JSON.stringify(validatedGuard)}\n`);
}

export function installVerifiedGuardForScope(scope: GuardScope, guard: Guard, environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): void {
  installVerifiedGuard(join(guardHomeForScope(scope, environment, cwd), "guards"), guard);
}
