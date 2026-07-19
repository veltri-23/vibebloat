import type { GuardClass } from "../types";
import type { IncidentManifest } from "../ingest/rank";

/**
 * Estimated minutes to notice and recover from one occurrence, by guard class.
 *
 * This is an ESTIMATE, not a measurement: transcripts record that an incident
 * happened, never how long the cleanup took. The figures are deliberately
 * conservative and the copy that shows them says so, because the product's
 * credibility rests on never dressing a guess as a measurement.
 *
 * A destroyed-work incident costs the most (rebuild what was lost); a broken
 * environment the least (usually a reinstall or a config revert).
 */
export const RECOVERY_MINUTES_BY_CLASS: Record<GuardClass, number> = {
  A: 30, // destroyed work that was not committed anywhere
  D: 20, // quietly wrong result: costly because it is found late
  B: 15, // bad edit or config that had to be reverted
  C: 10, // broken environment
};

/**
 * Hours this developer plausibly lost to repeated incidents. Returns undefined
 * when there is nothing to base a number on, so callers render a phrase rather
 * than inventing a figure.
 */
export function estimatedHoursLost(incidents: readonly IncidentManifest[]): number | undefined {
  const minutes = incidents.reduce((total, incident) => {
    const occurrences = Math.max(0, Math.floor(incident.frequency));
    return total + occurrences * (RECOVERY_MINUTES_BY_CLASS[incident.class] ?? RECOVERY_MINUTES_BY_CLASS.B);
  }, 0);
  return minutes > 0 ? minutes / 60 : undefined;
}
