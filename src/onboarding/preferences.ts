import { canonicalGateChoice, isGateChoice, type GateChoice, type GateId } from "./gates";
import type { RecallMode } from "../ingest/semantic-recall";

export type ModelRoute = "agent-session" | "api-key" | "local";

export interface OnboardingPreferences {
  answerTelemetry?: boolean;
  backgroundScan?: boolean;
  dailyStrengthening?: boolean;
  emailUpdates?: boolean;
  modelRoute?: ModelRoute;
  shareIncidents?: boolean;
  starterPack?: boolean;
  styleSource?: "written" | "code" | "none";
  uncertainPolicy?: "high-confidence-only" | "ai-double-check";
  updateMode?: "notify" | "automatic";
  agentCron?: boolean;
  communityStar?: "requested" | "later";
  teamUpdates?: boolean;
  recallMode?: RecallMode;
}

const preferenceGates = new Set<GateId>(["F1", "F1b", "F2", "F3", "F4", "F5", "F6", "G-empty", "I-zero", "N1", "N2", "O1", "O2", "O3", "SR", "SR-no-key"]);

/**
 * The SR / SR-no-key gate's option labels map to the recall mode the user
 * picked. Centralized here so the wording only lives in one place.
 */
export function recallModeForChoice(choice: string): RecallMode {
  if (choice.startsWith("Embed")) return "embed";
  if (choice.startsWith("Lexical")) return "lexical";
  if (choice.startsWith("Local")) return "local";
  return "off";
}

export function applyOnboardingPreference(
  preferences: OnboardingPreferences | undefined,
  gate: GateId,
  choice: GateChoice,
): OnboardingPreferences {
  const next = { ...preferences };
  if (!preferenceGates.has(gate) || !isGateChoice(gate, choice)) return next;
  const selected = canonicalGateChoice(gate, choice);
  switch (gate) {
    case "F1": next.shareIncidents = selected === "Yes, sharing on"; break;
    case "F1b": next.answerTelemetry = selected === "Sure"; break;
    case "F2": next.modelRoute = selected.startsWith("Just use this chat") ? "agent-session" : selected === "Use my own API key" ? "api-key" : "local"; break;
    case "F3": next.backgroundScan = selected.startsWith("Set up the important rules"); break;
    case "F4": next.uncertainPolicy = selected.startsWith("Double-check") ? "ai-double-check" : "high-confidence-only"; break;
    case "F5": next.styleSource = selected.startsWith("Use what") ? "written" : selected.startsWith("Figure") ? "code" : "none"; break;
    case "F6": next.emailUpdates = selected === "Yes"; next.starterPack = selected === "Yes"; break;
    case "G-empty": case "I-zero": next.starterPack = selected === "Yes"; break;
    case "N1": next.communityStar = selected === "Star" ? "requested" : "later"; break;
    case "N2": next.teamUpdates = selected.startsWith("Yes"); break;
    case "O1": next.dailyStrengthening = selected === "Yes"; break;
    case "O2": next.agentCron = selected === "Yes"; break;
    case "O3": next.updateMode = selected.startsWith("Auto-update") ? "automatic" : "notify"; break;
    case "SR":
    case "SR-no-key": next.recallMode = recallModeForChoice(selected); break;
  }
  return next;
}

export function modelCommandEnvironmentName(route: ModelRoute): string {
  return {
    "agent-session": "VIBEBLOAT_AGENT_MODEL_COMMAND",
    "api-key": "VIBEBLOAT_API_MODEL_COMMAND",
    local: "VIBEBLOAT_LOCAL_MODEL_COMMAND",
  }[route];
}
