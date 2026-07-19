import { rankIncidents, type IncidentManifest } from "../ingest/rank";
import { parseGuard } from "../schema";
import type { Guard } from "../types";
import { actionTypeForConfidence } from "./tiering";

/**
 * What the user reads when the guard fires: what happened, dated, and what to
 * do instead. A bare "found this N times" tells them nothing they can act on.
 */
function guardMessage(incident: IncidentManifest): string {
  const when = /^\d{4}-\d{2}-\d{2}$/.test(incident.recency) ? `${incident.recency.slice(5)} ` : "";
  const what = incident.condition.trim().replace(/\.$/, "");
  const advice = incident.remediation?.trim();
  return `${when}${what}.${advice ? ` ${advice.endsWith(".") ? advice : `${advice}.`}` : ""}`;
}

export function compileGuard(incident: IncidentManifest, confidence: "high" | "low"): Guard {
  if (incident.chokepoint === "shell" && !incident.command) throw new Error("Shell incident lacks a command.");
  if (incident.chokepoint === "file" && !incident.path) throw new Error("File incident lacks a path.");
  const message = guardMessage(incident);
  const actionType = actionTypeForConfidence(confidence);
  return parseGuard({
    id: incident.incident_id,
    class: incident.class,
    provenance: { incident: incident.condition, date: incident.recency, source: incident.evidence_refs[0] ?? "scan" },
    match: incident.chokepoint === "shell"
      ? {
        chokepoint: "shell",
        command: incident.command,
        ...(incident.args_contains?.length ? { argsContains: [...incident.args_contains] } : {}),
      }
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
