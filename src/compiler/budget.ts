import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Event, Guard } from "../types";

export type CompileTrigger = "mid-session" | "session-end";

export interface CompileBudgetClaim {
  status: "allowed" | "queued";
  warning?: string;
}

export interface QueuedCompileInput {
  guard: Guard;
  event: Event;
  trigger: CompileTrigger;
}

export interface QueuedCompileJob extends QueuedCompileInput {
  id: string;
  queuedAt: string;
}

export interface QueueDrainResult {
  completed: number;
  queued: number;
  failed: number;
}

interface CompileBudgetState {
  day: string;
  midSession: number;
  sessionEnd: number;
}

const limits: Record<CompileTrigger, number> = {
  "mid-session": 5,
  "session-end": 50,
};

const lockRetries = 25;
const lockRetryMs = 10;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

interface Ownership {
  pid: number;
  token: string;
}

interface BudgetLock {
  path: string;
  owner: Ownership;
}

function budgetPath(directory: string): string {
  return join(directory, "compile-budget.json");
}

function lockPath(directory: string): string {
  return join(directory, "compile-budget.lock");
}

function queueDirectory(directory: string): string {
  return join(directory, "compile-queue");
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function newState(day: string): CompileBudgetState {
  return { day, midSession: 0, sessionEnd: 0 };
}

function parseState(path: string, day: string): CompileBudgetState {
  if (!existsSync(path)) return newState(day);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Compile budget state is invalid.");
  const state = parsed as Partial<CompileBudgetState>;
  if (typeof state.day !== "string" || !Number.isInteger(state.midSession) || state.midSession < 0 || !Number.isInteger(state.sessionEnd) || state.sessionEnd < 0) {
    throw new Error("Compile budget state is invalid.");
  }
  return state.day === day ? { day, midSession: state.midSession, sessionEnd: state.sessionEnd } : newState(day);
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeStateAtomically(path: string, state: CompileBudgetState): void {
  writeAtomically(path, `${JSON.stringify(state)}\n`);
}

function stateKey(trigger: CompileTrigger): keyof Omit<CompileBudgetState, "day"> {
  return trigger === "mid-session" ? "midSession" : "sessionEnd";
}

function queueWarning(trigger: CompileTrigger, reason: string): CompileBudgetClaim {
  return { status: "queued", warning: `Live compile queued locally: ${reason}. Retry after the next UTC day (${limits[trigger]} ${trigger} compile limit per UTC day).` };
}

function parseOwnership(source: string): Ownership | undefined {
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = value as Partial<Ownership>;
    return Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token.length > 0
      ? { pid: owner.pid, token: owner.token }
      : undefined;
  } catch {
    return undefined;
  }
}

function lockOwner(path: string): Ownership | undefined {
  try {
    return parseOwnership(readFileSync(path, "utf8"));
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isCode(error, "ESRCH");
  }
}

function reclaimDeadLock(path: string, owner: Ownership): boolean {
  const tombstone = `${path}.${randomUUID()}.reap`;
  try {
    renameSync(path, tombstone);
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  }
  const movedOwner = lockOwner(tombstone);
  if (movedOwner?.token === owner.token && !processIsAlive(movedOwner.pid)) {
    rmSync(tombstone, { force: true });
    return true;
  }
  try {
    linkSync(tombstone, path);
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  } finally {
    rmSync(tombstone, { force: true });
  }
  return false;
}

function acquireLock(directory: string): BudgetLock | undefined {
  const path = lockPath(directory);
  mkdirSync(directory, { recursive: true });
  for (let attempt = 0; attempt < lockRetries; attempt += 1) {
    const owner = { pid: process.pid, token: randomUUID() };
    const candidate = join(directory, `.compile-budget.${owner.pid}.${owner.token}.candidate`);
    writeFileSync(candidate, JSON.stringify(owner), "utf8");
    try {
      linkSync(candidate, path);
      return { path, owner };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      const owner = lockOwner(path);
      if (owner && !processIsAlive(owner.pid) && reclaimDeadLock(path, owner)) continue;
      Atomics.wait(sleepCell, 0, 0, lockRetryMs);
    } finally {
      rmSync(candidate, { force: true });
    }
  }
  return undefined;
}

function releaseLock(lock: BudgetLock): void {
  if (lockOwner(lock.path)?.token === lock.owner.token) rmSync(lock.path, { force: true });
}

export function claimCompileBudget(directory: string, trigger: CompileTrigger, now = new Date()): CompileBudgetClaim {
  try {
    const lock = acquireLock(directory);
    if (!lock) return queueWarning(trigger, "another compile claim is still being processed");
    try {
      const state = parseState(budgetPath(directory), utcDay(now));
      const key = stateKey(trigger);
      if (state[key] >= limits[trigger]) return queueWarning(trigger, "daily budget is exhausted");
      state[key] += 1;
      writeStateAtomically(budgetPath(directory), state);
      return { status: "allowed" };
    } finally {
      releaseLock(lock);
    }
  } catch {
    return queueWarning(trigger, "budget state is unavailable");
  }
}

function queuedJobPath(directory: string, id: string): string {
  return join(queueDirectory(directory), `${id}.json`);
}

function processingJobPath(path: string, owner: Ownership): string {
  return path.replace(/\.json$/, `.${owner.pid}.${owner.token}.processing`);
}

function parseQueuedJob(path: string): QueuedCompileJob {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Queued compile job is invalid.");
  const job = parsed as Partial<QueuedCompileJob>;
  if (typeof job.id !== "string" || typeof job.queuedAt !== "string" || (job.trigger !== "mid-session" && job.trigger !== "session-end") || !job.guard || !job.event) {
    throw new Error("Queued compile job is invalid.");
  }
  return job as QueuedCompileJob;
}

function restoreOrphanedProcessingJobs(directory: string): void {
  const queue = queueDirectory(directory);
  if (!existsSync(queue)) return;
  for (const file of readdirSync(queue).filter((entry) => entry.endsWith(".processing"))) {
    const match = /^(.*)\.(\d+)\.([a-f0-9-]+)\.processing$/.exec(file);
    if (!match || processIsAlive(Number(match[2]))) continue;
    const processing = join(queue, file);
    try {
      renameSync(processing, join(queue, `${match[1]}.json`));
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) continue;
      throw error;
    }
  }
}

export function enqueueCompileJob(directory: string, input: QueuedCompileInput, now = new Date()): QueuedCompileJob {
  const job: QueuedCompileJob = { ...input, id: randomUUID(), queuedAt: now.toISOString() };
  writeAtomically(queuedJobPath(directory, job.id), `${JSON.stringify(job)}\n`);
  return job;
}

export function queuedCompileJobs(directory: string): QueuedCompileJob[] {
  const queue = queueDirectory(directory);
  if (!existsSync(queue)) return [];
  return readdirSync(queue)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseQueuedJob(join(queue, file)));
}

export function drainQueuedCompileJobs(
  directory: string,
  process: (job: QueuedCompileJob) => "completed" | "queued" | "failed",
): QueueDrainResult {
  restoreOrphanedProcessingJobs(directory);
  const queue = queueDirectory(directory);
  if (!existsSync(queue)) return { completed: 0, queued: 0, failed: 0 };
  const result: QueueDrainResult = { completed: 0, queued: 0, failed: 0 };
  for (const file of readdirSync(queue).filter((entry) => entry.endsWith(".json")).sort()) {
    const path = join(queue, file);
    const owner = { pid: process.pid, token: randomUUID() };
    const processing = processingJobPath(path, owner);
    try {
      renameSync(path, processing);
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "EEXIST")) continue;
      throw error;
    }
    let outcome: "completed" | "queued" | "failed" = "failed";
    try {
      outcome = process(parseQueuedJob(processing));
    } catch {
      outcome = "failed";
    }
    if (outcome === "completed") {
      rmSync(processing, { force: true });
    } else {
      renameSync(processing, path);
    }
    result[outcome] += 1;
  }
  return result;
}
