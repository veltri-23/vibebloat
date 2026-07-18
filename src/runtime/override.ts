import { createHash, randomUUID } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface PersistedOverride {
  version: 1;
  guardId: string;
}

function overridesDirectory(home: string): string {
  return join(home, "overrides");
}

function assertGuardId(guardId: string): void {
  if (!guardId || guardId.includes("\0")) throw new Error("Guard id is required.");
}

function statePath(home: string, guardId: string): string {
  const digest = createHash("sha256").update(guardId).digest("hex");
  return join(overridesDirectory(home), `${digest}.json`);
}

function parseState(value: string, guardId: string): PersistedOverride {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Override state is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Override state is invalid.");
  const state = parsed as Record<string, unknown>;
  if (state.version !== 1 || state.guardId !== guardId || Object.keys(state).length !== 2) {
    throw new Error("Override state is invalid.");
  }
  return state as PersistedOverride;
}

function isAlreadyPresent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Persist one override. Exclusive creation means concurrent requests cannot both succeed. */
export function allowOnce(guardId: string, home: string): void {
  assertGuardId(guardId);
  const directory = overridesDirectory(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = statePath(home, guardId);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, guardId } satisfies PersistedOverride)}\n`);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, path);
  } catch (error) {
    if (isAlreadyPresent(error)) {
      parseState(readFileSync(path, "utf8"), guardId);
      throw new Error("Override is already pending.");
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

/** Atomically claims the pending override. Only one matching hook can consume it. */
export function consumeAllowedOnce(guardId: string, home: string): boolean {
  assertGuardId(guardId);
  const path = statePath(home, guardId);
  const claimPath = `${path}.${process.pid}.${randomUUID()}.claim`;
  try {
    renameSync(path, claimPath);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    parseState(readFileSync(claimPath, "utf8"), guardId);
    return true;
  } finally {
    rmSync(claimPath, { force: true });
  }
}
