import type { GuardClass, Chokepoint } from "../types";

export interface IncidentManifest {
  incident_id: string;
  class: GuardClass;
  chokepoint: Chokepoint;
  command?: string;
  path?: string;
  /**
   * The arguments that made this occurrence destructive. Without them a guard
   * can only match the bare command, so "git stash -u deleted my files"
   * compiles to a rule that blocks every git stash — worse than no guard.
   */
  args_contains?: string[];
  condition: string;
  /**
   * The working tree the incident happened in. When present, the compiled guard
   * is scoped to fire only under this path -- "never again HERE" -- instead of
   * blocking the command everywhere.
   */
  context_cwd_under?: string;
  /** What to do instead. Shown to the user at block time. */
  remediation?: string;
  evidence_refs: string[];
  severity: number;
  frequency: number;
  recency: string;
}

export function rankIncidents(incidents: IncidentManifest[]): IncidentManifest[] {
  return [...incidents].sort((left, right) =>
    right.severity - left.severity
    || right.frequency - left.frequency
    || right.recency.localeCompare(left.recency)
    || left.incident_id.localeCompare(right.incident_id));
}
