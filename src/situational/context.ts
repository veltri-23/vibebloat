import { execSync } from "node:child_process";
import type { Event, Guard } from "../types";

/**
 * Live runtime-fact collectors. These shell out, so they are only ever called
 * on demand -- see enrichEventWithContext, which gathers a fact only when an
 * enabled situational guard both needs it and could match the command.
 */
export function gitHasUnstagedChanges(cwd: string): boolean {
  try {
    const out = execSync("git status --porcelain", { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function runningProcessNames(): string[] {
  try {
    if (process.platform === "win32") {
      const out = execSync("tasklist /fo csv /nh", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return out.split(/\r?\n/).map((line) => line.split(",")[0]?.replace(/"/g, "") ?? "").filter(Boolean);
    }
    const out = execSync("ps -eo comm", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

interface NeededFacts {
  cwd: boolean;
  processes: boolean;
  unstaged: boolean;
}

/**
 * Which live facts (if any) the enabled situational guards actually require for
 * THIS event. A guard is skipped unless it could plausibly match the command
 * (cheap substring prefilter on its binary), so a `git checkout` guard never
 * makes an `npm test` command pay for a process scan.
 */
export function neededFacts(guards: readonly Guard[], event: Event): NeededFacts {
  const needs: NeededFacts = { cwd: false, processes: false, unstaged: false };
  if (event.chokepoint !== "shell") return needs;
  for (const guard of guards) {
    const context = guard.enabled ? guard.match.context : undefined;
    if (!context) continue;
    if (guard.match.command) {
      const binary = guard.match.command.split(" ")[0];
      if (!event.command || !event.command.includes(binary)) continue;
    }
    if (context.cwdUnder !== undefined) needs.cwd = true;
    if (context.whenProcessRunning !== undefined) needs.processes = true;
    if (context.whenUnstagedChanges === true) needs.unstaged = true;
  }
  return needs;
}

/**
 * Attaches only the runtime facts a relevant situational guard needs. When no
 * situational guard is in play (the common case) this returns the event
 * untouched and does zero I/O -- enforcement stays exactly as fast as before.
 */
export function enrichEventWithContext(event: Event, guards: readonly Guard[]): Event {
  const needs = neededFacts(guards, event);
  if (!needs.cwd && !needs.processes && !needs.unstaged) return event;
  const cwd = process.cwd();
  return {
    ...event,
    ...(needs.cwd ? { cwd } : {}),
    ...(needs.processes ? { runningProcesses: runningProcessNames() } : {}),
    ...(needs.unstaged ? { hasUnstagedChanges: gitHasUnstagedChanges(cwd) } : {}),
  };
}

/** Eagerly gathers all facts for one command. Used by the demo and tests. */
export function gatherEventContext(command: string, cwd: string = process.cwd()): Event {
  return {
    chokepoint: "shell",
    command,
    cwd,
    hasUnstagedChanges: gitHasUnstagedChanges(cwd),
    runningProcesses: runningProcessNames(),
  };
}
