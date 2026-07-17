import { rankIncidents, type IncidentManifest } from "../ingest/rank";
import { parseGuard } from "../schema";
import type { Guard } from "../types";
import { actionTypeForConfidence } from "./tiering";

export function compileGuard(incident: IncidentManifest, confidence: "high" | "low"): Guard {
  if (incident.chokepoint === "shell" && !incident.command) throw new Error("Shell incident lacks a command.");
  if (incident.chokepoint === "file" && !incident.path) throw new Error("File incident lacks a path.");
  const actionType = actionTypeForConfidence(confidence);
  const message = `VibeBloat found ${incident.incident_id} in ${incident.frequency} incident${incident.frequency === 1 ? "" : "s"}.`;
  return parseGuard({
    id: incident.incident_id,
    class: incident.class,
    provenance: { incident: incident.condition, date: incident.recency, source: incident.evidence_refs[0] ?? "scan" },
    match: incident.chokepoint === "shell"
      ? { chokepoint: "shell", command: incident.command }
      : { chokepoint: "file", path: incident.path },
    action: { type: actionType, message, override: `vibebloat allow ${incident.incident_id} --once` },
    confidence,
    tier: "local",
    enabled: true,
  });
}

export function compileRankedIncidents(incidents: IncidentManifest[]): Guard[] {
  return rankIncidents(incidents).map((incident) => compileGuard(incident, incident.severity >= 4 ? "high" : "low"));
}
