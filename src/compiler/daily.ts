import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { readLastFiredSummaries } from "../audit/firings";
import { readInstalledAtByGuard, type GuardUpstreamVersions } from "../doctor/checks";
import { assessGuardStaleness, type StalenessReason } from "../doctor/staleness";
import { loadGuards } from "../guard-loader";
import { parseGuard } from "../schema";
import type { ActionType, Guard, GuardClass } from "../types";

const profileStaleMilliseconds = 90 * 24 * 60 * 60 * 1000;
const defaultProposalLimit = 50;
const maximumProposalLimit = 100;
const maximumEvidenceItems = 500;
const profileProbeBytes = 64 * 1024;
const guardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DailyEvidenceKind = "incident" | "compiler-issue";

export interface DailyEvidence {
  kind: DailyEvidenceKind;
  guardId?: string;
  candidateGuard?: unknown;
}

export type DailyProposalReason =
  | "profile-missing"
  | "profile-empty"
  | "profile-stale"
  | "proof-missing"
  | "candidate-not-installed"
  | "compiler-issue"
  | "audit-without-guard"
  | "guard-activity-missing"
  | StalenessReason;

export interface DailyProposal {
  type: "refresh-profile" | "prove-guards" | "create-guard" | "repair-guard" | "restore-guard" | "reaffirm-guard";
  reason: DailyProposalReason;
  guardId?: string;
  guardClass?: GuardClass;
  actionType?: ActionType;
}

export type DailyWarning =
  | "audit-read-failed"
  | "audit-data-invalid"
  | "evidence-limit-reached"
  | "guard-read-failed"
  | "invalid-evidence"
  | "profile-read-failed";

export interface DailyStrengtheningOptions {
  home: string;
  globalHome?: string;
  guardDirectories?: readonly string[];
  profilePath?: string;
  evidence?: readonly DailyEvidence[];
  upstreamVersions?: Readonly<Record<string, GuardUpstreamVersions>>;
  now?: Date;
  proposalLimit?: number;
}

export interface DailyStrengtheningResult {
  inspected: { guards: number; evidence: number };
  proposals: DailyProposal[];
  warnings: DailyWarning[];
}

function proposalLimit(value: number | undefined): number {
  if (value === undefined) return defaultProposalLimit;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Daily proposal limit must be a positive integer.");
  return Math.min(value, maximumProposalLimit);
}

function profileState(path: string, nowMilliseconds: number): DailyProposalReason | undefined {
  if (!existsSync(path)) return "profile-missing";
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Profile is not a regular file.");
  if (stat.size === 0) return "profile-empty";

  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, profileProbeBytes));
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (stat.size <= profileProbeBytes && !buffer.subarray(0, bytesRead).toString("utf8").trim()) return "profile-empty";
  } finally {
    closeSync(descriptor);
  }

  if (Number.isFinite(nowMilliseconds) && nowMilliseconds - stat.mtimeMs >= profileStaleMilliseconds) return "profile-stale";
  return undefined;
}

function latestTimestamp(left: string | Date | undefined, right: string | Date | undefined): string | Date | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const leftMilliseconds = left instanceof Date ? left.getTime() : Date.parse(left);
  const rightMilliseconds = right instanceof Date ? right.getTime() : Date.parse(right);
  if (!Number.isFinite(leftMilliseconds)) return left;
  if (!Number.isFinite(rightMilliseconds)) return right;
  return rightMilliseconds > leftMilliseconds ? right : left;
}

function proposalKey(proposal: DailyProposal): string {
  return [proposal.type, proposal.guardId ?? "", proposal.reason].join(":");
}

function compareProposals(left: DailyProposal, right: DailyProposal): number {
  const order: Record<DailyProposal["type"], number> = {
    "refresh-profile": 0,
    "prove-guards": 1,
    "create-guard": 2,
    "repair-guard": 3,
    "restore-guard": 4,
    "reaffirm-guard": 5,
  };
  return order[left.type] - order[right.type]
    || (left.guardId ?? "").localeCompare(right.guardId ?? "")
    || left.reason.localeCompare(right.reason);
}

function safeEvidenceGuard(evidence: DailyEvidence): Guard | undefined {
  if (evidence.candidateGuard === undefined) return undefined;
  return parseGuard(evidence.candidateGuard);
}

export function runDailyStrengthening(options: DailyStrengtheningOptions): DailyStrengtheningResult {
  const now = options.now ?? new Date();
  const nowMilliseconds = now.getTime();
  const directories = [...(options.guardDirectories ?? [join(options.home, "guards")])];
  const warnings = new Set<DailyWarning>();
  const guards: Guard[] = [];

  for (const directory of directories) {
    try {
      guards.push(...loadGuards(directory));
    } catch {
      warnings.add("guard-read-failed");
    }
  }

  const activeGuards = new Map<string, Guard>();
  for (const guard of guards) activeGuards.set(guard.id, guard);
  const proposals = new Map<string, DailyProposal>();
  const add = (proposal: DailyProposal): void => { proposals.set(proposalKey(proposal), proposal); };

  try {
    const reason = profileState(options.profilePath ?? join(options.home, "profile.md"), nowMilliseconds);
    if (reason) add({ type: "refresh-profile", reason });
  } catch {
    warnings.add("profile-read-failed");
  }

  if (activeGuards.size > 0 && !directories.some((directory) => existsSync(join(directory, "proof.json")))) {
    add({ type: "prove-guards", reason: "proof-missing" });
  }

  const installedAtByGuard = readInstalledAtByGuard([...activeGuards.values()], directories);
  const lastFiredAtByGuard: Record<string, string> = {};
  try {
    const audit = readLastFiredSummaries(options.globalHome ?? options.home, now);
    if (audit.quarantined > 0 || audit.warnings.length > 0) warnings.add("audit-data-invalid");
    for (const summary of audit.summaries) {
      lastFiredAtByGuard[summary.guardId] = summary.lastFiredAt;
      if (!activeGuards.has(summary.guardId)) add({ type: "restore-guard", guardId: summary.guardId, reason: "audit-without-guard" });
    }
  } catch {
    warnings.add("audit-read-failed");
  }

  for (const guard of [...activeGuards.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!guard.enabled) continue;
    const lastActivityAt = latestTimestamp(installedAtByGuard[guard.id], lastFiredAtByGuard[guard.id]);
    if (lastActivityAt === undefined) {
      add({ type: "reaffirm-guard", guardId: guard.id, reason: "guard-activity-missing" });
      continue;
    }
    const versions = options.upstreamVersions?.[guard.id];
    const assessment = assessGuardStaleness({
      lastFiredAt: lastActivityAt,
      installedUpstreamVersion: versions?.installed,
      currentUpstreamVersion: versions?.current,
      now,
    });
    for (const reason of assessment.reasons) add({ type: "reaffirm-guard", guardId: guard.id, reason });
  }

  const evidence = [...(options.evidence ?? [])];
  if (evidence.length > maximumEvidenceItems) warnings.add("evidence-limit-reached");
  const inspectedEvidence = Math.min(evidence.length, maximumEvidenceItems);
  for (const item of evidence.slice(0, maximumEvidenceItems)) {
    try {
      if (item.kind !== "incident" && item.kind !== "compiler-issue") throw new Error("Evidence kind is invalid.");
      const candidate = safeEvidenceGuard(item);
      const guardId = candidate?.id ?? item.guardId;
      if (!guardId || !guardIdPattern.test(guardId)) throw new Error("Evidence guard id is invalid.");
      if (candidate && !activeGuards.has(candidate.id)) {
        add({
          type: "create-guard",
          guardId: candidate.id,
          guardClass: candidate.class,
          actionType: candidate.action.type,
          reason: "candidate-not-installed",
        });
      } else if (item.kind === "compiler-issue") {
        add({ type: activeGuards.has(guardId) ? "repair-guard" : "restore-guard", guardId, reason: "compiler-issue" });
      }
    } catch {
      warnings.add("invalid-evidence");
    }
  }

  return {
    inspected: { guards: activeGuards.size, evidence: inspectedEvidence },
    proposals: [...proposals.values()].sort(compareProposals).slice(0, proposalLimit(options.proposalLimit)),
    warnings: [...warnings].sort(),
  };
}
