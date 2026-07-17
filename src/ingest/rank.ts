import type { GuardClass, Chokepoint } from "../types";

export interface IncidentManifest {
  incident_id: string;
  class: GuardClass;
  chokepoint: Chokepoint;
  command?: string;
  path?: string;
  condition: string;
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
