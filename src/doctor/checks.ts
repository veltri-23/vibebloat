import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Guard, GuardAgent } from "../types";
import { assessGuardStaleness } from "./staleness";

export interface DoctorFinding {
  status: "error" | "warning";
  check: "proof" | "claude-hook" | "codex-hook" | "guard-bind" | "guard-staleness" | "guard-conflict" | "source-health" | "index-freshness";
  message: string;
}

export interface GuardUpstreamVersions {
  installed?: string;
  current?: string;
}

export interface DoctorOptions {
  guardDirectory?: string;
  guardDirectories?: readonly string[];
  dataHomes?: readonly string[];
  guards?: readonly Guard[];
  lastFiredAtByGuard?: Readonly<Record<string, string | Date>>;
  installedAtByGuard?: Readonly<Record<string, string | Date>>;
  upstreamVersions?: Readonly<Record<string, GuardUpstreamVersions>>;
  now?: Date;
  installedAgents?: readonly GuardAgent[];
  sources?: readonly { id: string; reachable: boolean }[];
  semanticIndex?: { configured: boolean; lastUpdatedAt?: string | Date; staleAfterDays?: number };
  hookConfigs: { claude: string; codex: string; hermes?: string; openclaw?: string };
}

export type InstallationState = "installed" | "not-installed" | "partial";

const ownedDataNames = [
  "audit",
  "cache",
  "failed-ingest",
  "overrides",
  "compile-queue",
  "checkpoints",
  "receipts",
  "onboarding.json",
  "email.json",
  "compile-budget.json",
  "compile-budget.lock",
  "disabled.json",
] as const;

function hasChokepoint(agent: GuardAgent, hookConfigs: DoctorOptions["hookConfigs"]): boolean {
  switch (agent) {
    case "claude-code": return hookConfigs.claude.includes("vibebloat");
    case "codex": return hookConfigs.codex.includes("vibebloat") && /plugin_hooks\s*=\s*true/.test(hookConfigs.codex);
    case "hermes": return hookConfigs.hermes?.includes("vibebloat-hermes-pre-tool-call") === true;
    case "openclaw": return hookConfigs.openclaw?.includes("vibebloat") === true;
  }
}

function directoryHasData(directory: string): boolean {
  if (!existsSync(directory)) return false;
  try {
    return readdirSync(directory).length > 0;
  } catch {
    return true;
  }
}

export function installationState(options: DoctorOptions): InstallationState {
  const guardDirectories = options.guardDirectories ?? (options.guardDirectory ? [options.guardDirectory] : []);
  const hasProof = guardDirectories.some((directory) => existsSync(join(directory, "proof.json")));
  const hasGuardData = guardDirectories.some(directoryHasData);
  const hasOwnedData = (options.dataHomes ?? []).some((home) => ownedDataNames.some((name) => existsSync(join(home, name))));
  const hasVibeBloatHook = Object.values(options.hookConfigs).some((config) => config?.includes("vibebloat") === true);
  if (!hasProof && !hasGuardData && !hasOwnedData && !hasVibeBloatHook) return "not-installed";
  if (hasProof && hasChokepoint("claude-code", options.hookConfigs) && hasChokepoint("codex", options.hookConfigs)) return "installed";
  return "partial";
}

function latestTimestamp(values: readonly (string | Date | undefined)[]): string | Date | undefined {
  let latest: string | Date | undefined;
  let latestMilliseconds = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value === undefined) continue;
    const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
    if (!Number.isFinite(milliseconds)) return value;
    if (milliseconds > latestMilliseconds) {
      latest = value;
      latestMilliseconds = milliseconds;
    }
  }
  return latest;
}

function guardMatchKey(guard: Guard): string {
  return JSON.stringify({
    chokepoint: guard.match.chokepoint,
    command: guard.match.command,
    path: guard.match.path,
    argsContains: [...(guard.match.argsContains ?? [])].sort(),
    argsAnyOf: [...(guard.match.argsAnyOf ?? [])].sort(),
  });
}

export function readInstalledAtByGuard(
  guards: readonly Guard[],
  guardDirectories: readonly string[],
): Readonly<Record<string, Date>> {
  const proofTimes = guardDirectories.flatMap((directory) => {
    try {
      const path = join(directory, "proof.json");
      return existsSync(path) ? [statSync(path).mtime] : [];
    } catch {
      return [];
    }
  });
  const proofTime = proofTimes.sort((left, right) => right.getTime() - left.getTime())[0];
  return Object.fromEntries(guards.flatMap((guard) => {
    for (const directory of guardDirectories) {
      try {
        const path = join(directory, `${guard.id}.json`);
        if (existsSync(path)) return [[guard.id, statSync(path).mtime] as const];
      } catch {
        continue;
      }
    }
    return proofTime ? [[guard.id, proofTime] as const] : [];
  }));
}

export function runDoctor(options: DoctorOptions): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const guardDirectories = options.guardDirectories ?? (options.guardDirectory ? [options.guardDirectory] : []);
  const hasProof = guardDirectories.some((directory) => existsSync(join(directory, "proof.json")));
  if (!hasProof) findings.push({ status: "error", check: "proof", message: "No runner-written proof marker found." });
  if (!hasChokepoint("claude-code", options.hookConfigs)) findings.push({ status: "error", check: "claude-hook", message: "Claude Code hook is missing." });
  if (!hasChokepoint("codex", options.hookConfigs)) findings.push({ status: "error", check: "codex-hook", message: "Codex hook is missing." });
  const installedAgents = options.installedAgents ?? ["claude-code", "codex"];
  const missingByAgent = new Map<GuardAgent, string[]>();
  for (const guard of options.guards ?? []) {
    if (!guard.enabled) continue;
    const requiredAgents = guard.binds?.length
      ? guard.binds.filter((agent) => installedAgents.includes(agent))
      : installedAgents;
    for (const agent of requiredAgents) {
      if (hasChokepoint(agent, options.hookConfigs)) continue;
      const guardIds = missingByAgent.get(agent) ?? [];
      guardIds.push(guard.id);
      missingByAgent.set(agent, guardIds);
    }
  }
  for (const [agent, guardIds] of missingByAgent) {
    if (agent === "claude-code" || agent === "codex") continue;
    findings.push({
      status: "error",
      check: "guard-bind",
      message: `Guards ${guardIds.join(", ")} require ${agent}, but doctor could not verify its native chokepoint.`,
    });
  }
  const matchOwners = new Map<string, Guard>();
  for (const guard of options.guards ?? []) {
    if (!guard.enabled) continue;
    const key = guardMatchKey(guard);
    const prior = matchOwners.get(key);
    if (prior && prior.action.type !== guard.action.type) {
      findings.push({
        status: "error",
        check: "guard-conflict",
        message: `Guards ${prior.id} and ${guard.id} match the same event with different actions.`,
      });
    } else if (!prior) {
      matchOwners.set(key, guard);
    }
  }
  for (const source of options.sources ?? []) {
    if (!source.reachable) findings.push({ status: "error", check: "source-health", message: `History source ${source.id} is unreachable.` });
  }
  if (options.semanticIndex?.configured) {
    const staleAfterDays = options.semanticIndex.staleAfterDays ?? 7;
    const lastUpdatedAt = options.semanticIndex.lastUpdatedAt;
    const updatedMilliseconds = lastUpdatedAt instanceof Date ? lastUpdatedAt.getTime() : lastUpdatedAt ? Date.parse(lastUpdatedAt) : Number.NaN;
    const ageMilliseconds = (options.now ?? new Date()).getTime() - updatedMilliseconds;
    if (!Number.isFinite(updatedMilliseconds) || ageMilliseconds >= staleAfterDays * 86_400_000) {
      findings.push({ status: "warning", check: "index-freshness", message: "Semantic index is missing or stale." });
    }
  }
  for (const guard of options.guards ?? []) {
    if (!guard.enabled) continue;
    const versions = options.upstreamVersions?.[guard.id];
    const lastActivityAt = latestTimestamp([
      options.installedAtByGuard?.[guard.id],
      options.lastFiredAtByGuard?.[guard.id],
    ]);
    if (lastActivityAt === undefined && !(versions?.installed && versions.current)) continue;
    const assessment = assessGuardStaleness({
      lastFiredAt: lastActivityAt,
      installedUpstreamVersion: versions?.installed,
      currentUpstreamVersion: versions?.current,
      now: options.now ?? new Date(),
    });
    if (!assessment.needsReaffirmation) continue;
    findings.push({
      status: "warning",
      check: "guard-staleness",
      message: `Guard ${guard.id} needs reaffirmation: ${assessment.reasons.join(", ")}.`,
    });
  }
  return findings;
}
