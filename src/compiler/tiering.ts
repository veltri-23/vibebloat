import type { ActionType } from "../types";

export function actionTypeForConfidence(confidence: "high" | "low"): Extract<ActionType, "block" | "warn"> {
  return confidence === "high" ? "block" : "warn";
}
