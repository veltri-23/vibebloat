import { mkdirSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Runtime } from "../runtime";
import { parseGuard } from "../schema";
import type { Event, Guard } from "../types";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { claimCompileBudget, drainQueuedCompileJobs, enqueueCompileJob, type CompileTrigger, type QueueDrainResult } from "./budget";
import { writeProof } from "./proof";

export interface LiveCompileOptions {
  trigger: CompileTrigger;
  now?: Date;
}

export interface LiveCompileResult {
  status: "pass" | "fail" | "queued";
  warning?: string;
  queueId?: string;
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
  const validatedGuard = parseGuard(guard);
  const verdict = new Runtime().evaluate([validatedGuard], event);
  if (!verdict.fired) {
    writeProof(directory, { status: "fail", cases: ["synthetic event did not fire"] });
    return { status: "fail" };
  }
  replaceGuardAtomically(join(directory, `${validatedGuard.id}.json`), `${JSON.stringify(validatedGuard)}\n`);
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
): LiveCompileResult {
  const home = guardHomeForScope(scope, environment, cwd);
  const budget = claimCompileBudget(home, options.trigger, options.now);
  if (budget.status === "queued") {
    const job = enqueueCompileJob(home, { guard, event, trigger: options.trigger }, options.now);
    return { ...budget, warning: `${budget.warning} Job ${job.id} is stored in the local compile queue.`, queueId: job.id };
  }
  return compileLive(join(home, "guards"), guard, event);
}

export function drainQueuedLiveCompilesForScope(
  scope: GuardScope,
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  now = new Date(),
): QueueDrainResult {
  const home = guardHomeForScope(scope, environment, cwd);
  return drainQueuedCompileJobs(home, (job) => {
    const budget = claimCompileBudget(home, job.trigger, now);
    if (budget.status === "queued") return "queued";
    return compileLive(join(home, "guards"), job.guard, job.event).status === "pass" ? "completed" : "failed";
  });
}
