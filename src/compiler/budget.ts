import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type CompileTrigger = "mid-session" | "session-end";

export interface CompileBudgetClaim {
  status: "allowed" | "queued";
  warning?: string;
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

function budgetPath(directory: string): string {
  return join(directory, "compile-budget.json");
}

function lockPath(directory: string): string {
  return join(directory, "compile-budget.lock");
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
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

function writeStateAtomically(path: string, state: CompileBudgetState): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function stateKey(trigger: CompileTrigger): keyof Omit<CompileBudgetState, "day"> {
  return trigger === "mid-session" ? "midSession" : "sessionEnd";
}

function queueWarning(trigger: CompileTrigger, reason: string): CompileBudgetClaim {
  return { status: "queued", warning: `Live compile queued: ${reason} (${limits[trigger]} ${trigger} compile limit per UTC day).` };
}

export function claimCompileBudget(directory: string, trigger: CompileTrigger, now = new Date()): CompileBudgetClaim {
  const stateFile = budgetPath(directory);
  const lockFile = lockPath(directory);
  try {
    mkdirSync(directory, { recursive: true });
    let descriptor: number;
    try {
      descriptor = openSync(lockFile, "wx");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
        return queueWarning(trigger, "another compile claim is being processed");
      }
      throw error;
    }
    try {
      const state = parseState(stateFile, utcDay(now));
      const key = stateKey(trigger);
      if (state[key] >= limits[trigger]) return queueWarning(trigger, "daily budget is exhausted");
      state[key] += 1;
      writeStateAtomically(stateFile, state);
      return { status: "allowed" };
    } finally {
      closeSync(descriptor);
      rmSync(lockFile, { force: true });
    }
  } catch {
    return queueWarning(trigger, "budget state is unavailable");
  }
}
