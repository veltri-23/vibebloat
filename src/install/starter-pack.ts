import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Runtime } from "../runtime";
import { parseGuard } from "../schema";
import { syntheticEvent } from "../compiler/synthetic-event";
import type { Event, Guard } from "../types";
import { applyAtomicFilePlans, type AtomicFilePlan } from "./atomic-files";

const starterGuardValues = [
  {
    schemaVersion: 1,
    id: "starter-git-stash-untracked",
    class: "A",
    provenance: {
      incident: "Preventive starter-pack rule for git stash -u.",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action: {
      type: "block",
      message: "Preventive rule blocked git stash -u. Scope the stash with -- <path> or commit first.",
      override: "vibebloat allow starter-git-stash-untracked --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "starter-rm-recursive-force",
    class: "A",
    provenance: {
      incident: "Preventive starter-pack rule for rm -rf.",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "rm -rf" },
    action: {
      type: "block",
      message: "Preventive rule blocked rm -rf. Inspect the target and use a narrower removal command.",
      override: "vibebloat allow starter-rm-recursive-force --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "starter-git-force-push",
    class: "A",
    provenance: {
      incident: "Preventive starter-pack rule for git push -f.",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    // --force-with-lease is deliberately absent: it is the safe form, and
    // blocking it would be the false positive that gets the pack turned off.
    match: { chokepoint: "shell", command: "git push", argsAnyOf: ["-f", "--force"] },
    action: {
      type: "block",
      message: "Preventive rule blocked git push -f. Review remote history before overriding.",
      override: "vibebloat allow starter-git-force-push --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "starter-git-reset-hard",
    class: "A",
    provenance: {
      incident: "Preventive starter-pack rule for git reset --hard.",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "git reset", argsContains: ["--hard"] },
    action: {
      type: "block",
      message: "Preventive rule blocked git reset --hard. Preserve wanted work before overriding.",
      override: "vibebloat allow starter-git-reset-hard --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
] as const;

export interface StarterGuardPackInstallReport {
  guardIds: string[];
  writtenPaths: string[];
}

export function starterGuardPack(): Guard[] {
  return starterGuardValues.map((guard) => parseGuard(structuredClone(guard)));
}

function serializedGuard(guard: Guard): string {
  return `${JSON.stringify(guard)}\n`;
}

function preflightPlans(guardDirectory: string, guards: readonly Guard[]): AtomicFilePlan[] {
  const directory = resolve(guardDirectory);
  if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing starter-pack install through symbolic-link guard directory: ${directory}`);
  }

  const runtime = new Runtime();
  for (const guard of guards) {
    const verdict = runtime.evaluate([guard], syntheticEvent(guard));
    if (!verdict.fired || verdict.blocked !== true) {
      throw new Error(`Starter guard failed synthetic proof: ${guard.id}`);
    }
  }

  return guards.flatMap((guard) => {
    const path = join(directory, `${guard.id}.json`);
    const content = serializedGuard(guard);
    if (!existsSync(path)) return [{ path, content, mode: 0o600 }];
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to replace symbolic link: ${path}`);
    if (readFileSync(path, "utf8") !== content) {
      throw new Error(`Starter guard conflicts with existing local guard: ${guard.id}`);
    }
    return [];
  });
}

export function installGuardPack(guards: readonly Guard[], guardDirectory: string): StarterGuardPackInstallReport {
  const plans = preflightPlans(guardDirectory, guards);
  applyAtomicFilePlans(plans);
  return {
    guardIds: guards.map(({ id }) => id),
    writtenPaths: plans.map(({ path }) => resolve(path)),
  };
}

export function installStarterGuardPack(guardDirectory: string): StarterGuardPackInstallReport {
  return installGuardPack(starterGuardPack(), guardDirectory);
}
