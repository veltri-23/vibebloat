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
  complete: false;
  doctor: {
    healthy: boolean;
    findings: DoctorFinding[];
    auditWarnings: AuditWarning[];
  };
  daily: DailyCommandResult;
  incrementalScan: {
    status: "blocked";
    reason: "No durable returning-scan cursor exists.";
  };
}

export type ReturningServiceResult = ManageRulesResult | CatchUpResult;

function unsupportedScan(gate: "R1" | "R2"): never {
  const action = gate === "R1" ? "since-last-run problem scan" : "targeted project or tool scan";
  throw new Error(`${action} is unavailable because no durable returning-scan cursor exists.`);
}

export function runReturningService(
  gate: Exclude<ReturningGate, "R0">,
  options: ReturningServiceOptions,
): ReturningServiceResult {
  if (gate === "R1" || gate === "R2") return unsupportedScan(gate);

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
  return {
    kind: "catch-up",
    complete: false,
    doctor: {
      healthy: findings.every((finding) => finding.status !== "error"),
      findings,
      auditWarnings: lastFired.warnings,
    },
    daily,
    incrementalScan: {
      status: "blocked",
      reason: "No durable returning-scan cursor exists.",
    },
  };
}
