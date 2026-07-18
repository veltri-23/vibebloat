import { mkdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime } from "../runtime";
import type { Event, Guard } from "../types";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { claimCompileBudget, type CompileTrigger } from "./budget";
import { writeProof } from "./proof";

export interface LiveCompileOptions {
  trigger: CompileTrigger;
  now?: Date;
}

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

export function compileLiveForScope(
  scope: GuardScope,
  guard: Guard,
  event: Event,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  options: LiveCompileOptions = { trigger: "session-end" },
): { status: "pass" | "fail" | "queued"; warning?: string } {
  const home = guardHomeForScope(scope, environment, cwd);
  const budget = claimCompileBudget(home, options.trigger, options.now);
  if (budget.status === "queued") return budget;
  return compileLive(join(home, "guards"), guard, event);
}
