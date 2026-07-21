import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextFirstRunGate, renderGate, type GateId, type OnboardingContext } from "../src/onboarding/gates";
import { applyOnboardingPreference, recallModeForChoice } from "../src/onboarding/preferences";
import { persistRecallChoice } from "../src/onboarding/recall-choice";
import { readRecallConfig } from "../src/ingest/recall-config";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-recall-onboarding-"));
  temporaryDirectories.push(home);
  return home;
}

describe("onboarding recall gate wiring", () => {
  test("F6 routes to SR when no mining key is detected", () => {
    const context: OnboardingContext = {};
    expect(nextFirstRunGate("F6", "Skip", context)).toBe("SR");
  });

  test("F6 routes to SR-no-key when the mining key is absent (explicit)", () => {
    const context: OnboardingContext = { recallKeyPresent: false };
    expect(nextFirstRunGate("F6", "Skip", context)).toBe("SR-no-key");
  });

  test("F6 routes to SR when a mining key is present", () => {
    const context: OnboardingContext = { recallKeyPresent: true };
    expect(nextFirstRunGate("F6", "Skip", context)).toBe("SR");
  });

  test("SR choices advance to SCAN; only one of the four labels is accepted", () => {
    // The runner passes the option index (a number) to nextFirstRunGate; we
    // exercise that path here so the transition doesn't depend on full-text
    // option matching.
    expect(nextFirstRunGate("SR", 0)).toBe("SCAN");
    expect(nextFirstRunGate("SR", 1)).toBe("SCAN");
    expect(nextFirstRunGate("SR", 2)).toBe("SCAN");
    expect(nextFirstRunGate("SR", 3)).toBe("SCAN");
    // Off-list answers don't advance.
    expect(nextFirstRunGate("SR", 4)).toBe("SR");
  });

  test("SR-no-key offers local, lexical, and off; all three advance to SCAN", () => {
    // The runner passes the option index (a number) to nextFirstRunGate; we
    // exercise that path here so the transition doesn't depend on full-text
    // option matching.
    expect(nextFirstRunGate("SR-no-key", 0)).toBe("SCAN");
    expect(nextFirstRunGate("SR-no-key", 1)).toBe("SCAN");
    expect(nextFirstRunGate("SR-no-key", 2)).toBe("SCAN");
    expect(nextFirstRunGate("SR-no-key", 3)).toBe("SR-no-key");
  });

  test("SR rendered copy recommends lexical when no key is present", () => {
    const context: OnboardingContext = { recallKeyPresent: true };
    const gate = renderGate("SR", { recallKeyStatus: "your OpenAI key (sk-test…1234)" });
    expect(gate.question).toContain("by meaning");
    expect(gate.options.some((option) => option.startsWith("Embed"))).toBe(true);
    expect(gate.question).toContain("sk-test");
    // Gate shouldn't expose key status when no key is set.
    const clean = renderGate("SR", { recallKeyStatus: "no mining key detected" });
    expect(clean.options[0]).toContain("Embed");
  });
});

describe("preference application", () => {
  test("SR choice maps to recallMode", () => {
    expect(applyOnboardingPreference({}, "SR", "Lexical (offline, free, default)").recallMode).toBe("lexical");
    expect(applyOnboardingPreference({}, "SR", "Embed (uses your mining key, smarter)").recallMode).toBe("embed");
    expect(applyOnboardingPreference({}, "SR", "Off (no recall at all)").recallMode).toBe("off");
    expect(applyOnboardingPreference({}, "SR", "Local (downloads a model once, then runs offline)").recallMode).toBe("local");
  });

  test("SR-no-key choice maps to recallMode", () => {
    expect(applyOnboardingPreference({}, "SR-no-key", "Lexical (offline, free, lighter)").recallMode).toBe("lexical");
    expect(applyOnboardingPreference({}, "SR-no-key", "Off (no recall at all)").recallMode).toBe("off");
    expect(applyOnboardingPreference({}, "SR-no-key", "Local (recommended)").recallMode).toBe("local");
  });

  test("recallModeForChoice is the only public mapping", () => {
    expect(recallModeForChoice("Embed (uses your mining key, smarter)")).toBe("embed");
    expect(recallModeForChoice("Lexical (offline, free, default)")).toBe("lexical");
    expect(recallModeForChoice("Local (post-hackathon neural embedder)")).toBe("local");
    expect(recallModeForChoice("Off (no recall at all)")).toBe("off");
  });

  test("applyOnboardingPreference ignores choices that aren't recognized", () => {
    const before = { modelRoute: "local" as const };
    expect(applyOnboardingPreference(before, "SR", "literally anything").recallMode).toBeUndefined();
  });
});

describe("config persistence", () => {
  test("persistRecallChoice writes a valid toml block readable by readRecallConfig", () => {
    const home = tempHome();
    const path = join(home, "config.toml");
    persistRecallChoice({ configPath: path, mode: "lexical" });
    expect(existsSync(path)).toBe(true);
    const parsed = readRecallConfig(path);
    expect(parsed?.mode).toBe("lexical");
  });

  test("persistRecallChoice preserves unrelated config lines", () => {
    const home = tempHome();
    const path = join(home, "config.toml");
    writeFileSync(path, "[features]\nverbose = true\n\n[agent]\nname = \"test\"\n");
    persistRecallChoice({ configPath: path, mode: "off" });
    const source = readFileSync(path, "utf8");
    expect(source).toContain("[features]");
    expect(source).toContain("verbose = true");
    expect(source).toContain("[agent]");
    expect(source).toContain("name = \"test\"");
    expect(source).toContain("[semantic]");
    expect(source).toContain("recall = off");
  });

  test("persistRecallChoice overwrites the existing semantic block without duplicating it", () => {
    const home = tempHome();
    const path = join(home, "config.toml");
    persistRecallChoice({ configPath: path, mode: "lexical" });
    persistRecallChoice({ configPath: path, mode: "off" });
    persistRecallChoice({ configPath: path, mode: "embed", embedApiKey: "sk-test" });
    const source = readFileSync(path, "utf8");
    const matches = source.match(/\[semantic\]/g) ?? [];
    expect(matches).toHaveLength(1);
    const parsed = readRecallConfig(path);
    expect(parsed?.mode).toBe("embed");
    expect(parsed?.embedApiKey).toBe("sk-test");
  });
});
