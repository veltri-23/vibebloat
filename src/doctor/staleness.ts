const ninetyDaysMilliseconds = 90 * 24 * 60 * 60 * 1000;

export type StalenessReason =
  | "last-fired-at-missing"
  | "last-fired-at-invalid"
  | "last-fired-at-future"
  | "no-fire-in-90-days"
  | "current-time-invalid"
  | "upstream-version-drift";

export interface GuardStalenessInput {
  lastFiredAt?: string | Date;
  installedUpstreamVersion?: string;
  currentUpstreamVersion?: string;
  now: Date;
}

export interface GuardStalenessAssessment {
  needsReaffirmation: boolean;
  reasons: StalenessReason[];
}

function timestampMilliseconds(value: string | Date | undefined): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

function suppliedVersion(value: string | undefined): string | undefined {
  const version = value?.trim();
  return version || undefined;
}

export function assessGuardStaleness(input: GuardStalenessInput): GuardStalenessAssessment {
  const reasons: StalenessReason[] = [];
  const now = input.now.getTime();
  const lastFiredAt = timestampMilliseconds(input.lastFiredAt);

  if (!Number.isFinite(now)) reasons.push("current-time-invalid");
  if (input.lastFiredAt === undefined || input.lastFiredAt === "") reasons.push("last-fired-at-missing");
  else if (lastFiredAt === undefined) reasons.push("last-fired-at-invalid");
  else if (Number.isFinite(now) && lastFiredAt > now) reasons.push("last-fired-at-future");
  else if (Number.isFinite(now) && now - lastFiredAt >= ninetyDaysMilliseconds) reasons.push("no-fire-in-90-days");

  const installedVersion = suppliedVersion(input.installedUpstreamVersion);
  const currentVersion = suppliedVersion(input.currentUpstreamVersion);
  if (installedVersion && currentVersion && installedVersion !== currentVersion) reasons.push("upstream-version-drift");

  return { needsReaffirmation: reasons.length > 0, reasons };
}
