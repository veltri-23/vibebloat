import { homedir } from "node:os";
import { join } from "node:path";

export type GuardScope = "repo" | "machine";

type Environment = NodeJS.ProcessEnv;

function userHome(environment: Environment): string {
  return environment.USERPROFILE ?? environment.HOME ?? homedir();
}

export function globalGuardHome(environment: Environment = process.env): string {
  return join(userHome(environment), ".vibebloat");
}

export function projectGuardHome(cwd = process.cwd()): string {
  return join(cwd, ".vibebloat");
}

/** Explicit VIBEBLOAT_HOME keeps the legacy single-home contract for CI and existing installs. */
export function guardHomes(environment: Environment = process.env, cwd = process.cwd()): string[] {
  if (environment.VIBEBLOAT_HOME) return [environment.VIBEBLOAT_HOME];
  return [globalGuardHome(environment), projectGuardHome(cwd)];
}

export function guardDirectories(environment: Environment = process.env, cwd = process.cwd()): string[] {
  return guardHomes(environment, cwd).map((home) => join(home, "guards"));
}

export function guardHomeForScope(scope: GuardScope, environment: Environment = process.env, cwd = process.cwd()): string {
  if (environment.VIBEBLOAT_HOME) return environment.VIBEBLOAT_HOME;
  return scope === "repo" ? projectGuardHome(cwd) : globalGuardHome(environment);
}

export function onboardingHome(environment: Environment = process.env, cwd = process.cwd()): string {
  return environment.VIBEBLOAT_HOME ?? projectGuardHome(cwd);
}
