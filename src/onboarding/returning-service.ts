import { readAndPruneFirings, readLastFiredSummaries, type AuditWarning } from "../audit/firings";
import { runDailyStrengtheningCommand, type DailyCommandOptions, type DailyCommandResult } from "../cli/daily";
import { summarizeRules, type RuleSummary } from "../cli/rules";
import { runDoctor, type DoctorFinding, type DoctorOptions } from "../doctor/checks";
import type { Guard } from "../types";
import type { ReturningGate } from "./returning";

export interface ReturningServiceOptions {
  globalHome: string;
  guards: readonly Guard[];
  disabledGuardIds?: Iterable<string>;
  doctorOptions?: DoctorOptions;
  dailyOptions?: DailyCommandOptions;
  now?: Date;
  incrementalScan?: (gate: "R1" | "R2" | "R4") => Promise<ReturningIncrementalScanResult>;
}

export interface ReturningIncrementalScanResult {
  status: "ingested" | "paused";
  chunksScanned: number;
  incidentsFound: number;
}

export interface ReturningRuleActivity extends RuleSummary {
  firingCount: number;
  lastFiredAt: string | null;
}

export interface ManageRulesResult {
  kind: "manage-rules";
  rules: ReturningRuleActivity[];
  mostOverridden: null;
  limitations: readonly ["Historical override counts are not recorded."];
  auditWarnings: AuditWarning[];
}

export interface CatchUpResult {
  kind: "catch-up";
  complete: boolean;
  doctor: {
    healthy: boolean;
    findings: DoctorFinding[];
    auditWarnings: AuditWarning[];
  };
  daily: DailyCommandResult;
  incrementalScan: ReturningIncrementalScanResult | { status: "blocked"; reason: "No durable returning-scan cursor exists." };
}

export interface ProblemScanResult {
  kind: "scan-problem";
  compareExistingRules: true;
  incrementalScan: ReturningIncrementalScanResult;
}

export interface ProjectScanResult {
  kind: "discover-project-or-tool";
  scopedRules: true;
  incrementalScan: ReturningIncrementalScanResult;
}

export type ReturningServiceResult = ManageRulesResult | CatchUpResult | ProblemScanResult | ProjectScanResult;

async function runIncrementalScan(options: ReturningServiceOptions, gate: "R1" | "R2" | "R4"): Promise<ReturningIncrementalScanResult> {
  if (!options.incrementalScan) throw new Error("Returning scan is unavailable because no durable returning-scan cursor is configured.");
  const result = await options.incrementalScan(gate);
  if (result.status !== "ingested" && result.status !== "paused") throw new Error("Returning scan returned an invalid status.");
  if (!Number.isSafeInteger(result.chunksScanned) || result.chunksScanned < 0 || !Number.isSafeInteger(result.incidentsFound) || result.incidentsFound < 0) {
    throw new Error("Returning scan returned invalid counts.");
  }
  return result;
}

export async function runReturningService(
  gate: Exclude<ReturningGate, "R0">,
  options: ReturningServiceOptions,
): Promise<ReturningServiceResult> {
  if (gate === "R1") return { kind: "scan-problem", compareExistingRules: true, incrementalScan: await runIncrementalScan(options, gate) };
  if (gate === "R2") return { kind: "discover-project-or-tool", scopedRules: true, incrementalScan: await runIncrementalScan(options, gate) };

  const now = options.now ?? new Date();
  if (gate === "R3") {
    const audit = readAndPruneFirings(options.globalHome, now);
    const activity = new Map<string, { count: number; lastFiredAt: string }>();
    for (const event of audit.events) {
      const current = activity.get(event.guardId);
      activity.set(event.guardId, {
        count: (current?.count ?? 0) + 1,
        lastFiredAt: current?.lastFiredAt && current.lastFiredAt > event.firedAt ? current.lastFiredAt : event.firedAt,
      });
    }
    return {
      kind: "manage-rules",
      rules: summarizeRules(options.guards, options.disabledGuardIds).map((rule) => ({
        ...rule,
        firingCount: activity.get(rule.id)?.count ?? 0,
        lastFiredAt: activity.get(rule.id)?.lastFiredAt ?? null,
      })),
      mostOverridden: null,
      limitations: ["Historical override counts are not recorded."],
      auditWarnings: audit.warnings,
    };
  }

  if (!options.doctorOptions) throw new Error("Catch-up requires doctor options.");
  const lastFired = readLastFiredSummaries(options.globalHome, now);
  const findings = runDoctor({
    ...options.doctorOptions,
    now,
    lastFiredAtByGuard: {
      ...options.doctorOptions.lastFiredAtByGuard,
      ...Object.fromEntries(lastFired.summaries.map((summary) => [summary.guardId, summary.lastFiredAt])),
    },
  });
  const daily = runDailyStrengtheningCommand({ ...options.dailyOptions, now });
  let incrementalScan: CatchUpResult["incrementalScan"];
  try {
    incrementalScan = await runIncrementalScan(options, "R4");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/no durable returning-scan cursor exists/i.test(message)) throw error;
    incrementalScan = { status: "blocked", reason: "No durable returning-scan cursor exists." };
  }
  return {
    kind: "catch-up",
    complete: incrementalScan.status === "ingested",
    doctor: {
      healthy: findings.every((finding) => finding.status !== "error"),
      findings,
      auditWarnings: lastFired.warnings,
    },
    daily,
    incrementalScan,
  };
}
