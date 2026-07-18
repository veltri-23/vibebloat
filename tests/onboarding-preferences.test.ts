import { expect, test } from "bun:test";
import { applyOnboardingPreference, modelCommandEnvironmentName } from "../src/onboarding/preferences";

test("locked onboarding choices persist their operational effect", () => {
  let preferences;
  preferences = applyOnboardingPreference(preferences, "F1", "Yes, but sharing off");
  preferences = applyOnboardingPreference(preferences, "F1b", "Sure");
  preferences = applyOnboardingPreference(preferences, "F2", "c");
  preferences = applyOnboardingPreference(preferences, "F3", "b");
  preferences = applyOnboardingPreference(preferences, "F4", "b");
  preferences = applyOnboardingPreference(preferences, "F5", "c");
  preferences = applyOnboardingPreference(preferences, "F6", "a");
  preferences = applyOnboardingPreference(preferences, "N1", "b");
  preferences = applyOnboardingPreference(preferences, "N2", "a");
  preferences = applyOnboardingPreference(preferences, "O1", "a");
  preferences = applyOnboardingPreference(preferences, "O2", "b");
  preferences = applyOnboardingPreference(preferences, "O3", "b");

  expect(preferences).toEqual({
    shareIncidents: false,
    answerTelemetry: true,
    modelRoute: "local",
    backgroundScan: true,
    uncertainPolicy: "ai-double-check",
    styleSource: "none",
    emailUpdates: true,
    starterPack: true,
    communityStar: "later",
    teamUpdates: true,
    dailyStrengthening: true,
    agentCron: false,
    updateMode: "automatic",
  });
});

test("invalid free-form text cannot change locked preferences", () => {
  expect(applyOnboardingPreference({ modelRoute: "local" }, "F2", "do something else")).toEqual({ modelRoute: "local" });
});

test("each model route has a distinct adapter contract", () => {
  expect(modelCommandEnvironmentName("agent-session")).toBe("VIBEBLOAT_AGENT_MODEL_COMMAND");
  expect(modelCommandEnvironmentName("api-key")).toBe("VIBEBLOAT_API_MODEL_COMMAND");
  expect(modelCommandEnvironmentName("local")).toBe("VIBEBLOAT_LOCAL_MODEL_COMMAND");
});
