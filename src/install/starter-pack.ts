import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Runtime } from "../runtime";
import { parseGuard } from "../schema";
import { syntheticEvent } from "../compiler/synthetic-event";
import type { Event, Guard } from "../types";
import { applyAtomicFilePlans, type AtomicFilePlan } from "./atomic-files";

// Generic cold-start guard pack. These are NOT mined from the user's own
// history and NOT situational: they ship with the install and fire on common
// foot-guns across all users. Because they can false-positive (the cost of
// turning the whole pack off), the shell rules emit `warn` rather than `block`
// -- the user sees the warning and can override. The `.env` rule keeps
// `require-confirm` because a confirm prompt is cheap and the cost of an
// accidental secret write is high.
const starterGuardValues = [
  {
    schemaVersion: 1,
    id: "starter-git-stash-untracked",
    class: "A",
    provenance: {
      incident: "Generic cold-start rule for git stash -u (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action: {
      type: "warn",
      message: "Generic rule: git stash -u can drop untracked files. Scope it with -- <path> or commit first.",
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
      incident: "Generic cold-start rule for rm -rf (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "rm -rf" },
    action: {
      type: "warn",
      message: "Generic rule: rm -rf is irreversible. Inspect the target and use a narrower removal.",
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
      incident: "Generic cold-start rule for git push -f (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    // --force-with-lease is deliberately absent: it is the safe form, and
    // blocking it would be the false positive that gets the pack turned off.
    match: { chokepoint: "shell", command: "git push", argsAnyOf: ["-f", "--force"] },
    action: {
      type: "warn",
      message: "Generic rule: git push -f rewrites remote history. Review before overriding.",
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
      incident: "Generic cold-start rule for git reset --hard (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "git reset", argsContains: ["--hard"] },
    action: {
      type: "warn",
      message: "Generic rule: git reset --hard drops uncommitted work. Stash or use --soft first.",
      override: "vibebloat allow starter-git-reset-hard --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "starter-git-checkout-discard",
    class: "A",
    provenance: {
      incident: "Generic cold-start rule for git checkout . discarding uncommitted edits (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "git checkout", argsContains: ["."] },
    action: {
      type: "warn",
      message: "Generic rule: git checkout . discards every uncommitted edit. Scope to git checkout -- <path>.",
      override: "vibebloat allow starter-git-checkout-discard --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "starter-git-clean-force",
    class: "A",
    provenance: {
      incident: "Generic cold-start rule for forced git clean deleting untracked files (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "shell", command: "git clean", argsAnyOf: ["-f", "-ff", "-fd", "-df", "-fdx", "-xdf", "-dfx", "-xfd", "--force"] },
    action: {
      type: "warn",
      message: "Generic rule: forced git clean deletes untracked files forever. Dry-run with git clean -n first.",
      override: "vibebloat allow starter-git-clean-force --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "starter-env-file-confirm",
    class: "B",
    provenance: {
      incident: "Generic cold-start rule for agent writes to .env secret files (not from your history).",
      date: "2026-07-18",
      source: "vibebloat-starter-pack",
    },
    match: { chokepoint: "file", path: ".env" },
    action: {
      type: "require-confirm",
      message: "Generic rule: paused a write to .env. Secrets live here -- confirm the change is intentional.",
      override: "vibebloat allow starter-env-file-confirm --once",
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
    // The synthetic proof only needs to demonstrate the guard fires on its
    // locked example; both `block` and `warn` actions count as fired.
    if (!verdict.fired) {
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
