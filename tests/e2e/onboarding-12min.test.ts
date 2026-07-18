import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverLocalHistory } from "../../src/ingest/discovery";
import type { IncidentManifest } from "../../src/ingest/rank";
import { OnboardingCoordinator } from "../../src/onboarding/coordinator";
import { createLocalOnlySink } from "../../src/scrub/local-sink";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const redactBearer = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload: payload.replace(/Bearer\\s+\\S+/g, 'Bearer <redacted>'), findings: [] })); })",
];

const passThrough = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload, findings: [] })); })",
];

function filesBelow(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

test("A through O coordinates discovery, consent, scrub, review, install, and proof", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-onboarding-e2e-"));
  roots.push(root);
  const sessionPath = join(root, ".hermes", "profiles", "default", "sessions", "failed.json");
  mkdirSync(join(sessionPath, ".."), { recursive: true });
  writeFileSync(sessionPath, JSON.stringify({
    session_id: "hermes-failure",
    request: {
      headers: { Authorization: "Bearer raw-provider-token" },
      body: { messages: [{ role: "user", content: "Authorization: Bearer raw-provider-token failed after git stash -u removed work" }] },
    },
  }));
  const catalog = discoverLocalHistory({ homeDirectory: root, now: new Date("2026-07-18T12:00:00.000Z") });
  const incident: IncidentManifest = {
    incident_id: "protect-untracked-stash",
    class: "A",
    chokepoint: "shell",
    command: "git stash -u",
    condition: "destructive stash removed untracked work",
    evidence_refs: ["hermes-failure:0"],
    severity: 5,
    frequency: 2,
    recency: "2026-07-18",
  };
  let scrubbersVerified = false;
  let bindingsInstalled = false;
  const coordinator = new OnboardingCoordinator({
    discover: async () => ({
      environments: catalog.sources.map((source) => ({ id: source.id, label: source.label })),
      sources: catalog.sources.map((source) => ({
        id: source.id,
        environmentId: source.id,
        label: `${source.label} history`,
        lastActive: source.lastActivityAt,
        stale: source.stale,
      })),
    }),
    verifyScrubbers: () => { scrubbersVerified = true; },
    loadHistory: async (sourceIds, authorization) => catalog.loadConfirmed({
      ...authorization,
      scrubbersVerified: scrubbersVerified && authorization.scrubbersVerified,
      sourceIds: sourceIds as Array<"claude-code" | "codex" | "hermes">,
    }),
    scan: {
      presidioCommand: redactBearer,
      gitleaksCommand: passThrough,
      localSink: createLocalOnlySink(join(root, "quarantine")),
      modelPass: async (candidates) => {
        expect(candidates).toHaveLength(1);
        expect(candidates[0]!.content).toContain("Bearer <redacted>");
        expect(candidates[0]!.content).not.toContain("raw-provider-token");
        return [incident];
      },
    },
    installBindings: () => { bindingsInstalled = true; },
    cwd: root,
  });

  coordinator.begin("repo");
  expect((await coordinator.permitSetupAndDiscover(true))?.environments.map(({ id }) => id)).toEqual(["hermes"]);
  coordinator.confirmEnvironments(true);
  coordinator.selectSources(["hermes"]);
  coordinator.consent(true);
  expect((await coordinator.scan()).phase).toBe("review");
  coordinator.review([{ incidentId: incident.incident_id, approved: true, confidence: "high" }]);
  expect((await coordinator.install()).phase).toBe("ready-to-prove");
  expect(bindingsInstalled).toBeTrue();
  expect(coordinator.prove()).toBeTrue();
  expect(coordinator.snapshot().phase).toBe("complete");

  const installedRoot = join(root, ".vibebloat");
  const persisted = filesBelow(installedRoot).map((path) => readFileSync(path, "utf8")).join("\n");
  expect(persisted).not.toContain("raw-provider-token");
  expect(persisted).not.toContain(root);
});
