import { mkdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime } from "../runtime";
import type { Event, Guard } from "../types";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { writeProof } from "./proof";

export function replaceGuardAtomically(path: string, content: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, content);
  renameSync(temporaryPath, path);
}

export function guardWatchPath(directory: string, filename: string | Buffer | null): string | undefined {
  if (!filename || !filename.toString().endsWith(".json")) return undefined;
  return join(directory, filename.toString());
}

export function watchGuardDirectory(directory: string, onChange: (path: string) => void): FSWatcher {
  return watch(directory, { persistent: false }, (_eventType, filename) => {
    const path = guardWatchPath(directory, filename);
    if (path) onChange(path);
  });
}

export function compileLive(directory: string, guard: Guard, event: Event): { status: "pass" | "fail" } {
  const verdict = new Runtime().evaluate([guard], event);
  if (!verdict.fired) {
    writeProof(directory, { status: "fail", cases: ["synthetic event did not fire"] });
    return { status: "fail" };
  }
  replaceGuardAtomically(join(directory, `${guard.id}.json`), `${JSON.stringify(guard)}\n`);
  writeProof(directory, { status: "pass", cases: ["synthetic event fired"] });
  return { status: "pass" };
}

export function compileLiveForScope(scope: GuardScope, guard: Guard, event: Event, environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): { status: "pass" | "fail" } {
  return compileLive(join(guardHomeForScope(scope, environment, cwd), "guards"), guard, event);
}
