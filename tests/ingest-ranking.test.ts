import { expect, test } from "bun:test";
import { rankIncidents, type IncidentManifest } from "../src/ingest/rank";

test("incident ranking orders severity, frequency, then recency", () => {
  const incidents: IncidentManifest[] = [
    { incident_id: "low", class: "C", chokepoint: "file", path: ".env", condition: "", evidence_refs: [], severity: 1, frequency: 8, recency: "2026-07-17" },
    { incident_id: "high", class: "A", chokepoint: "shell", command: "git stash", condition: "", evidence_refs: [], severity: 5, frequency: 2, recency: "2026-07-16" },
  ];

  expect(rankIncidents(incidents).map((incident) => incident.incident_id)).toEqual(["high", "low"]);
});
