import { rankIncidents } from "../ingest/rank";
import { estimatedHoursLost } from "../stats/time-cost";
import { gateValues } from "./gates";
import type { OnboardingCheckpoint } from "./coordinator";

/**
 * Binds onboarding copy to what was actually measured on this machine. Fields
 * with no measurement are left undefined so gateValues renders a vague phrase
 * rather than a borrowed figure.
 */
export function onboardingGateValues(
  checkpoint: OnboardingCheckpoint | undefined,
): Record<string, string | number> {
  const incidents = checkpoint?.incidents ?? [];
  const top = rankIncidents(incidents)[0];
  const environments = checkpoint?.discovery?.environments.map(({ label, id }) => label || id).filter(Boolean) ?? [];
  const hermes = checkpoint?.discovery?.environments.find(({ id }) => id === "hermes" || id === "openclaw");
  const hours = estimatedHoursLost(incidents);
  return gateValues({
    ...(incidents.length > 0 ? {
      incidentsFound: incidents.length,
      confidentCount: incidents.filter(({ severity }) => severity >= 4).length,
      uncertainCount: incidents.filter(({ severity }) => severity < 4).length,
    } : {}),
    ...(checkpoint?.sessionsScanned === undefined ? {} : { sessionsScanned: checkpoint.sessionsScanned }),
    ...(checkpoint?.sessionsBySource && Object.keys(checkpoint.sessionsBySource).length > 0
      ? { sessionsBySource: formatSessionsBySource(checkpoint.sessionsBySource) }
      : checkpoint?.sessionsScanned !== undefined
        ? { sessionsBySource: `${checkpoint.sessionsScanned}` }
        : {}),
    ...(hours === undefined ? {} : { hoursLost: hours }),
    ...(top ? {
      topIncidentDate: top.recency,
      incidentClass: top.class,
      ...(top.command ? { topIncidentCommand: top.command } : {}),
    } : {}),
    ...(environments.length > 0 ? { environments } : {}),
    ...(hermes ? { hermesLabel: hermes.label || hermes.id } : {}),
    // The agent the user is talking through, never the detection mechanism:
    // "talking to me through environment" is not a sentence.
    ...(environments[0] ? { runnerAgent: environments[0] } : {}),
  });
}

/**
 * Renders the per-source breakdown for the I1 gate text. Two sources become
 * "5 from Claude Code + 2 from Hermes"; one source becomes "5 from Claude
 * Code"; the total replaces the breakdown when the entries add up to it
 * (which is the common single-source case) so the user sees a clean number.
 */
export function formatSessionsBySource(bySource: Record<string, number>): string {
  const entries = Object.entries(bySource).sort(([, a], [, b]) => b - a);
  if (entries.length === 1) {
    const [source, count] = entries[0]!;
    return `${count} from ${labelForSource(source)}`;
  }
  return entries.map(([source, count]) => `${count} from ${labelForSource(source)}`).join(" + ");
}

function labelForSource(source: string): string {
  switch (source) {
    case "claude-code": return "Claude Code";
    case "codex": return "Codex";
    case "hermes": return "Hermes";
    case "openclaw": return "OpenClaw";
    default: return source;
  }
}

