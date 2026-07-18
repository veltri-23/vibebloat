import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OnboardingCoordinator, reviewDecisionForChoice, type OnboardingCoordinatorOptions } from "../../src/onboarding/coordinator";
import { createLocalOnlySink } from "../../src/scrub/local-sink";
import type { IncidentManifest } from "../../src/ingest/rank";
import { getGate } from "../../src/onboarding/gates";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const presidioRedact = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload: payload.replace(/Bearer\\s+\\S+/g, 'Bearer <redacted>'), findings: [] })); })",
];

const cleanScrubber = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload, findings: [] })); })",
];

const failedScrubber = ["bun", "-e", "process.exit(1)"];

const incident: IncidentManifest = {
  incident_id: "stash-untracked",
  class: "A",
  chokepoint: "shell",
  command: "git stash -u",
  condition: "destructive stash removed untracked work",
  evidence_refs: ["session-1:0"],
  severity: 5,
  frequency: 2,
  recency: "2026-07-15",
};

function fixture(overrides: Partial<OnboardingCoordinatorOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "vibebloat-onboarding-"));
  tempDirectories.push(root);
  const calls: string[] = [];
  const options: OnboardingCoordinatorOptions = {
    discover: async () => {
      calls.push("discover");
      return {
        environments: [{ id: "hermes", label: "Hermes" }],
        sources: [{ id: "hermes-history", environmentId: "hermes", label: "Hermes history" }],
      };
    },
    verifyScrubbers: async () => { calls.push("verify-scrubbers"); },
    loadHistory: async (sourceIds, authorization) => {
      expect(authorization).toEqual({ confirmed: true, scrubbersVerified: true });
      calls.push(`load:${sourceIds.join(",")}`);
      return [{
        source: "hermes",
        sessionId: "session-1",
        messageIndex: 0,
        chunkIndex: 0,
        role: "user",
        content: "Authorization: Bearer raw-token failed after git stash -u",
      }];
    },
    scan: {
      presidioCommand: presidioRedact,
      gitleaksCommand: cleanScrubber,
      localSink: createLocalOnlySink(join(root, "quarantine")),
      modelPass: async (candidates) => {
        calls.push("model");
        expect(candidates[0]?.content).toContain("Bearer <redacted>");
        expect(candidates[0]?.content).not.toContain("raw-token");
        return [incident];
      },
    },
    installBindings: async (guards, environmentIds) => { calls.push(`bind:${guards.map(({ id }) => id).join(",")}:${environmentIds.join(",")}`); },
    cwd: root,
    ...overrides,
  };
  return { coordinator: new OnboardingCoordinator(options), options, root, calls };
}

async function reachPrivacy(coordinator: OnboardingCoordinator) {
  coordinator.begin("repo");
  await coordinator.permitSetupAndDiscover(true);
  coordinator.confirmEnvironments(true);
  coordinator.selectSources(["hermes-history"]);
}

test("side effects stay ordered behind permission, confirmation, consent, and review", async () => {
  const { coordinator, calls } = fixture();

  coordinator.begin("repo");
  expect(await coordinator.permitSetupAndDiscover(false)).toBeUndefined();
  expect(calls).toEqual([]);
  await coordinator.permitSetupAndDiscover(true);
  expect(coordinator.confirmEnvironments(false).phase).toBe("confirm-environments");
  expect(() => coordinator.selectSources(["hermes-history"])).toThrow("expected triage");
  coordinator.confirmEnvironments(true);
  coordinator.selectSources(["hermes-history"]);
  coordinator.consent(true);
  await coordinator.scan();
  expect(() => coordinator.review([])).toThrow("Every mined incident requires an explicit review decision");
  coordinator.review([{ incidentId: incident.incident_id, approved: true }]);
  await coordinator.install();
  expect(coordinator.prove()).toBeTrue();

  expect(calls).toEqual(["discover", "verify-scrubbers", "load:hermes-history", "model", "bind:stash-untracked:hermes"]);
  expect(coordinator.snapshot()).toMatchObject({ phase: "complete", installedGuardIds: ["stash-untracked"] });
});

test("privacy cancellation saves progress and never reads history", async () => {
  const saved: string[] = [];
  const { coordinator, calls } = fixture({ save: (snapshot) => { saved.push(snapshot.phase); } });
  await reachPrivacy(coordinator);

  expect(coordinator.consent(false)).toMatchObject({ phase: "cancelled", cancelled: true });
  expect(calls).toEqual(["discover"]);
  expect(saved.at(-1)).toBe("cancelled");
  await expect(coordinator.scan()).rejects.toThrow("expected ready-to-scan");
});

test("unsafe discovery identifiers never reach saved onboarding state", async () => {
  const saved: unknown[] = [];
  const { coordinator } = fixture({
    discover: async () => ({
      environments: [{ id: "C:\\Users\\person", label: "unsafe" }],
      sources: [],
    }),
    save: (snapshot) => { saved.push(snapshot); },
  });
  coordinator.begin("repo");

  await expect(coordinator.permitSetupAndDiscover(true)).rejects.toThrow("unsafe identifier");
  expect(coordinator.discovery()).toBeUndefined();
  expect(saved).toHaveLength(1);
});

test("environment confirmation can revise a validated discovery before triage", async () => {
  const { coordinator } = fixture();
  coordinator.begin("repo");
  await coordinator.permitSetupAndDiscover(true);
  expect(coordinator.reviseDiscovery({
    environments: [{ id: "codex", label: "Codex" }],
    sources: [],
  }).phase).toBe("confirm-environments");
  expect(coordinator.discovery()).toEqual({ environments: [{ id: "codex", label: "Codex" }], sources: [] });
  expect(() => coordinator.reviseDiscovery({
    environments: [{ id: "unsafe/path", label: "unsafe" }],
    sources: [],
  })).toThrow("Discovery returned an unsafe identifier");
});

test("scrub failure pauses before model, review, compile, or binding", async () => {
  let modelCalls = 0;
  let bindingCalls = 0;
  const root = mkdtempSync(join(tmpdir(), "vibebloat-onboarding-scrub-"));
  tempDirectories.push(root);
  const sink = join(root, "quarantine");
  const { coordinator } = fixture({
    scan: {
      presidioCommand: presidioRedact,
      gitleaksCommand: failedScrubber,
      localSink: createLocalOnlySink(sink),
      modelPass: async () => { modelCalls += 1; return [incident]; },
    },
    installBindings: async () => { bindingCalls += 1; },
  });
  await reachPrivacy(coordinator);
  coordinator.consent(true);

  expect(await coordinator.scan()).toMatchObject({ phase: "paused", incidentCount: 0, installedGuardIds: [] });
  expect({ modelCalls, bindingCalls }).toEqual({ modelCalls: 0, bindingCalls: 0 });
  const [quarantined] = readdirSync(sink);
  expect(readFileSync(join(sink, quarantined), "utf8")).toContain("Bearer raw-token");
});

test("scrubber preflight failure pauses before raw history is read", async () => {
  let historyReads = 0;
  const { coordinator } = fixture({
    verifyScrubbers: () => { throw new Error("controlled scrubbers unavailable"); },
    loadHistory: async () => { historyReads += 1; return []; },
  });
  await reachPrivacy(coordinator);
  coordinator.consent(true);

  expect(await coordinator.scan()).toMatchObject({ phase: "paused", incidentCount: 0 });
  expect(historyReads).toBe(0);
});

test("verified scrubber commands replace placeholders after preflight", async () => {
  const { coordinator } = fixture({
    verifyScrubbers: () => ({ presidio: presidioRedact, gitleaks: cleanScrubber }),
    scan: {
      presidioCommand: failedScrubber,
      gitleaksCommand: failedScrubber,
      localSink: createLocalOnlySink(join(tmpdir(), `vibebloat-onboarding-verified-${crypto.randomUUID()}`)),
      modelPass: async () => [incident],
    },
  });
  await reachPrivacy(coordinator);
  coordinator.consent(true);

  expect(await coordinator.scan()).toMatchObject({ phase: "review", incidentCount: 1 });
});

test("checkpoint resumes without rereading history before scan", async () => {
  const original = fixture();
  await reachPrivacy(original.coordinator);
  original.coordinator.consent(true);
  const resumed = new OnboardingCoordinator({ ...original.options, resume: original.coordinator.checkpoint() });

  expect(resumed.snapshot()).toMatchObject({ phase: "ready-to-scan", consented: true, selectedSourceIds: ["hermes-history"] });
  expect(await resumed.scan()).toMatchObject({ phase: "review", incidentCount: 1 });
});

test("interrupted onboarding scan resumes post-scrub without rereading history", async () => {
  let modelCalls = 0;
  const original = fixture({
    scan: {
      presidioCommand: presidioRedact,
      gitleaksCommand: cleanScrubber,
      localSink: createLocalOnlySink(join(tmpdir(), `vibebloat-onboarding-resume-${crypto.randomUUID()}`)),
      modelPass: async () => { modelCalls += 1; throw new Error("model interrupted"); },
    },
  });
  await reachPrivacy(original.coordinator);
  original.coordinator.consent(true);
  await expect(original.coordinator.scan()).rejects.toThrow("model interrupted");

  const resumed = new OnboardingCoordinator({
    ...original.options,
    resume: original.coordinator.checkpoint(),
    loadHistory: async () => { throw new Error("history must not be reread"); },
    scan: {
      ...original.options.scan,
      modelPass: async (candidates) => {
        modelCalls += 1;
        expect(candidates[0]).toMatchObject({ frequency: 1, evidenceRefs: ["hermes:session-1:0:0"] });
        return [incident];
      },
    },
  });

  expect(await resumed.scan()).toMatchObject({ phase: "review", incidentCount: 1 });
  expect(modelCalls).toBe(2);
});

test("tampered checkpoint cannot restore unknown selected history", async () => {
  const original = fixture();
  await reachPrivacy(original.coordinator);
  const checkpoint = original.coordinator.checkpoint();
  checkpoint.selectedSourceIds = ["missing-history"];

  expect(() => new OnboardingCoordinator({ ...original.options, resume: checkpoint })).toThrow("unknown history source");
});

test("review choices approve only final decisions", () => {
  expect(reviewDecisionForChoice("J1-unsure", "Yes", "incident")).toBeUndefined();
  expect(reviewDecisionForChoice("J1-unsure", "No", "incident")).toEqual({ incidentId: "incident", approved: false });
  expect(reviewDecisionForChoice("J1", "Change it", "incident")).toBeUndefined();
  expect(reviewDecisionForChoice("J1", "Yes, set it up", "incident")).toEqual({ incidentId: "incident", approved: true });
  expect(reviewDecisionForChoice("J1", "Skip", "incident")).toEqual({ incidentId: "incident", approved: false });
});

test("successful review compiles, proves, and installs only approved guards", async () => {
  const { coordinator, root } = fixture();
  await reachPrivacy(coordinator);
  coordinator.consent(true);
  expect(await coordinator.scan()).toMatchObject({ phase: "review", incidentCount: 1 });
  expect(coordinator.incidents()).toEqual([incident]);
  coordinator.review([{ incidentId: incident.incident_id, approved: true, confidence: "high" }]);

  expect(await coordinator.install()).toMatchObject({ phase: "ready-to-prove", installedGuardIds: [incident.incident_id] });
  const guardPath = join(root, ".vibebloat", "guards", `${incident.incident_id}.json`);
  expect(existsSync(guardPath)).toBeTrue();
  expect(JSON.parse(readFileSync(guardPath, "utf8"))).toMatchObject({ id: incident.incident_id, action: { type: "block" } });
  expect(JSON.parse(readFileSync(join(root, ".vibebloat", "guards", "proof.json"), "utf8"))).toEqual({ status: "pass", cases: ["synthetic event fired: stash-untracked"] });
  expect(coordinator.prove(incident.incident_id)).toBeTrue();
});

test("binding failure leaves zero guard or proof files", async () => {
  const { coordinator, root } = fixture({ installBindings: async () => { throw new Error("native binding failed"); } });
  await reachPrivacy(coordinator);
  coordinator.consent(true);
  await coordinator.scan();
  coordinator.review([{ incidentId: incident.incident_id, approved: true }]);

  await expect(coordinator.install()).rejects.toThrow("native binding failed");
  expect(existsSync(join(root, ".vibebloat", "guards"))).toBeFalse();
});

test("unsafe model output never reaches review, guard storage, or bindings", async () => {
  let bindingCalls = 0;
  const { coordinator, root } = fixture({
    scan: {
      presidioCommand: presidioRedact,
      gitleaksCommand: cleanScrubber,
      localSink: createLocalOnlySink(join(tmpdir(), `vibebloat-onboarding-model-${crypto.randomUUID()}`)),
      modelPass: async () => [{ ...incident, condition: "Authorization: Bearer model-secret" }],
    },
    installBindings: async () => { bindingCalls += 1; },
  });
  await reachPrivacy(coordinator);
  coordinator.consent(true);

  await expect(coordinator.scan()).rejects.toThrow("Mined incident contains unsanitized secret material");
  expect(coordinator.snapshot()).toMatchObject({ phase: "ready-to-scan", incidentCount: 0, installedGuardIds: [] });
  expect(bindingCalls).toBe(0);
  expect(existsSync(join(root, ".vibebloat", "guards"))).toBeFalse();
});

test("model output with path, email, or high-entropy token never reaches review", async () => {
  for (const condition of [
    "failed at C:\\Users\\person\\secret.ts",
    "contact person@example.com",
    "credential abcdefghijklmnopqrstuvwxyz123456",
  ]) {
    const { coordinator } = fixture({
      scan: {
        presidioCommand: presidioRedact,
        gitleaksCommand: cleanScrubber,
        localSink: createLocalOnlySink(join(tmpdir(), `vibebloat-onboarding-model-${crypto.randomUUID()}`)),
        modelPass: async () => [{ ...incident, condition }],
      },
    });
    await reachPrivacy(coordinator);
    coordinator.consent(true);
    await expect(coordinator.scan()).rejects.toThrow("Mined incident contains");
    expect(coordinator.snapshot().phase).toBe("ready-to-scan");
  }
});

test("locked script wording is rendered rather than rewritten", () => {
  const { coordinator } = fixture();
  expect(coordinator.prompt("F1")).toEqual(getGate("F1"));
});
