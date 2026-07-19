import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { compileGuard } from "../compiler/codex-fill";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { seedIncrementalCursor } from "../ingest/incremental-cursor";
import { scanHistory, type ScanOptions } from "../ingest/scan";
import type { IncidentManifest } from "../ingest/rank";
import type { HistoryChunk } from "../ingest/types";
import { applyAtomicFilePlans } from "../install/atomic-files";
import { Runtime } from "../runtime";
import { parseGuard } from "../schema";
import type { Event, Guard } from "../types";
import { renderGate, type GateId } from "./gates";
import type { Scrubber } from "../scrub/presidio";

/**
 * A verified scrubber pair. Commands point at a signed release binary;
 * functions run the built-in scrubber in-process. Both fail closed.
 */
export interface VerifiedScrubbers {
  presidio: readonly string[] | Scrubber;
  gitleaks: readonly string[] | Scrubber;
}

function scrubberScanOptions(verified: VerifiedScrubbers): Partial<ScanOptions<IncidentManifest>> {
  return {
    ...(typeof verified.presidio === "function" ? { presidio: verified.presidio } : { presidioCommand: verified.presidio }),
    ...(typeof verified.gitleaks === "function" ? { gitleaks: verified.gitleaks } : { gitleaksCommand: verified.gitleaks }),
  };
}

export type OnboardingPhase =
  | "entry"
  | "setup-permission"
  | "confirm-environments"
  | "triage"
  | "privacy"
  | "ready-to-scan"
  | "review"
  | "ready-to-install"
  | "ready-to-prove"
  | "complete"
  | "paused"
  | "cancelled";

export interface DiscoveredEnvironment {
  id: string;
  label: string;
}

export interface DiscoveredHistorySource {
  id: string;
  environmentId: string;
  label: string;
  lastActive?: string;
  stale?: boolean;
}

export interface OnboardingDiscovery {
  environments: DiscoveredEnvironment[];
  sources: DiscoveredHistorySource[];
}

export interface GuardReviewDecision {
  incidentId: string;
  approved: boolean;
  confidence?: "high" | "low";
}

export function reviewDecisionForChoice(
  gate: "J1" | "J1-unsure",
  choice: string,
  incidentId: string,
): GuardReviewDecision | undefined {
  if (gate === "J1-unsure") return choice === "No" ? { incidentId, approved: false } : undefined;
  if (choice === "Yes, set it up") return { incidentId, approved: true };
  if (choice === "Skip" || choice === "That wasn't really a mistake") return { incidentId, approved: false };
  return undefined;
}

export interface OnboardingSnapshot {
  phase: OnboardingPhase;
  scope?: GuardScope;
  environmentConfirmed: boolean;
  consented: boolean;
  selectedSourceIds: string[];
  incidentCount: number;
  approvedIncidentIds: string[];
  installedGuardIds: string[];
  cancelled: boolean;
}

export interface OnboardingCheckpoint extends OnboardingSnapshot {
  scanRunId?: string;
  discovery?: OnboardingDiscovery;
  incidents: IncidentManifest[];
  approved: Array<{ incident: IncidentManifest; confidence: "high" | "low" }>;
  installed: Guard[];
}

export interface OnboardingCoordinatorOptions {
  discover(): Promise<OnboardingDiscovery>;
  setupBindings?(): Promise<void> | void;
  verifyScrubbers(): Promise<VerifiedScrubbers | void> | VerifiedScrubbers | void;
  loadHistory(sourceIds: readonly string[], authorization: { confirmed: true; scrubbersVerified: true }): Promise<HistoryChunk[]>;
  scan: Omit<ScanOptions<IncidentManifest>, "publish">;
  installBindings(guards: readonly Guard[], environmentIds: readonly string[]): Promise<void> | void;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  incrementalCursor?: {
    directory: string;
    maxSessionsPerSource?: number;
  };
  resume?: OnboardingCheckpoint;
  save?(checkpoint: OnboardingCheckpoint): void;
}

const rawSecret = /\bBearer\s+(?!<redacted>)\S+|\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*(?!<redacted>)\S+|\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_~+\/=.-]{32,}\b/i;
const email = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const embeddedAbsolutePath = /(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|(?:^|[\s"'`])\/(?:home|Users|var|tmp|etc|opt|root)\/)/i;
const identifier = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const absolutePath = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function syntheticEvent(guard: Guard): Event {
  return guard.match.chokepoint === "shell"
    ? { chokepoint: "shell", command: guard.match.command }
    : { chokepoint: "file", path: guard.match.path };
}

function assertSafeIncident(incident: IncidentManifest): void {
  const required = ["incident_id", "class", "chokepoint", "condition", "evidence_refs", "severity", "frequency", "recency"];
  const allowed = new Set([...required, "command", "path"]);
  if (required.some((key) => !(key in incident)) || Object.keys(incident).some((key) => !allowed.has(key))) {
    throw new Error("Mined incident has an invalid schema.");
  }
  const serialized = JSON.stringify(incident);
  if (rawSecret.test(serialized)) throw new Error("Mined incident contains unsanitized secret material.");
  if (email.test(serialized)) throw new Error("Mined incident contains personal data.");
  if (embeddedAbsolutePath.test(serialized)) throw new Error("Mined incident contains an absolute path.");
  if (incident.path && absolutePath.test(incident.path)) throw new Error("Mined incident path must be repository-relative.");
  if (incident.evidence_refs.some((reference) => absolutePath.test(reference))) throw new Error("Mined incident evidence must not contain absolute paths.");
  compileGuard(incident, incident.severity >= 4 ? "high" : "low");
}

function assertSafeIncidents(incidents: readonly IncidentManifest[]): void {
  incidents.forEach(assertSafeIncident);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function assertSafeDiscovery(discovery: OnboardingDiscovery): void {
  const environmentIds = unique(discovery.environments.map(({ id }) => id));
  const sourceIds = unique(discovery.sources.map(({ id }) => id));
  if (environmentIds.length !== discovery.environments.length || sourceIds.length !== discovery.sources.length) {
    throw new Error("Discovery returned duplicate identifiers.");
  }
  if ([...environmentIds, ...sourceIds].some((id) => id.length > 80 || !identifier.test(id))) {
    throw new Error("Discovery returned an unsafe identifier.");
  }
  const knownEnvironments = new Set(environmentIds);
  if (discovery.sources.some(({ environmentId }) => !knownEnvironments.has(environmentId))) {
    throw new Error("Discovery returned a source for an unknown environment.");
  }
}

/** Owns onboarding side effects; OnboardingRunner remains exact conversation owner. */
export class OnboardingCoordinator {
  #phase: OnboardingPhase = "entry";
  #scope?: GuardScope;
  #discovery?: OnboardingDiscovery;
  #environmentConfirmed = false;
  #consented = false;
  #selectedSourceIds: string[] = [];
  #incidents: IncidentManifest[] = [];
  #approved: Array<{ incident: IncidentManifest; confidence: "high" | "low" }> = [];
  #installed: Guard[] = [];
  #cancelled = false;
  #scanRunId = randomUUID();

  constructor(private readonly options: OnboardingCoordinatorOptions) {
    if (!options.resume) return;
    const checkpoint = structuredClone(options.resume);
    if (checkpoint.scanRunId !== undefined && !/^[a-f0-9-]{36}$/.test(checkpoint.scanRunId)) throw new Error("Checkpoint scan identity is invalid.");
    if (checkpoint.discovery) assertSafeDiscovery(checkpoint.discovery);
    checkpoint.incidents.forEach(assertSafeIncident);
    checkpoint.approved.forEach(({ incident }) => assertSafeIncident(incident));
    const incidentIds = new Set(checkpoint.incidents.map(({ incident_id }) => incident_id));
    if (checkpoint.approved.some(({ incident }) => !incidentIds.has(incident.incident_id))) throw new Error("Checkpoint approval references an unknown incident.");
    const sourceIds = new Set(checkpoint.discovery?.sources.map(({ id }) => id) ?? []);
    if (checkpoint.selectedSourceIds.some((id) => !sourceIds.has(id))) throw new Error("Checkpoint selected an unknown history source.");
    this.#phase = checkpoint.phase;
    this.#scope = checkpoint.scope;
    this.#discovery = checkpoint.discovery;
    this.#environmentConfirmed = checkpoint.environmentConfirmed;
    this.#consented = checkpoint.consented;
    this.#selectedSourceIds = [...checkpoint.selectedSourceIds];
    this.#incidents = checkpoint.incidents;
    this.#approved = checkpoint.approved;
    this.#installed = checkpoint.installed.map((guard) => parseGuard(JSON.stringify(guard)));
    this.#cancelled = checkpoint.cancelled;
    if (checkpoint.scanRunId) this.#scanRunId = checkpoint.scanRunId;
  }

  snapshot(): OnboardingSnapshot {
    return {
      phase: this.#phase,
      scope: this.#scope,
      environmentConfirmed: this.#environmentConfirmed,
      consented: this.#consented,
      selectedSourceIds: [...this.#selectedSourceIds],
      incidentCount: this.#incidents.length,
      approvedIncidentIds: this.#approved.map(({ incident }) => incident.incident_id),
      installedGuardIds: this.#installed.map((guard) => guard.id),
      cancelled: this.#cancelled,
    };
  }

  checkpoint(): OnboardingCheckpoint {
    return {
      ...this.snapshot(),
      scanRunId: this.#scanRunId,
      discovery: this.discovery(),
      incidents: this.incidents(),
      approved: this.#approved.map(({ incident, confidence }) => ({
        incident: { ...incident, evidence_refs: [...incident.evidence_refs] },
        confidence,
      })),
      installed: structuredClone(this.#installed),
    };
  }

  prompt(gate: GateId, values: Record<string, string | number> = {}) {
    return renderGate(gate, values);
  }

  begin(scope: GuardScope): OnboardingSnapshot {
    this.#expect("entry");
    this.#scope = scope;
    this.#phase = "setup-permission";
    return this.#save();
  }

  async permitSetupAndDiscover(permitted: boolean): Promise<OnboardingDiscovery | undefined> {
    this.#expect("setup-permission");
    if (!permitted) return undefined;
    await this.options.setupBindings?.();
    const discovery = await this.options.discover();
    assertSafeDiscovery(discovery);
    this.#discovery = {
      environments: discovery.environments.map((environment) => ({ ...environment })),
      sources: discovery.sources.map((source) => ({ ...source })),
    };
    this.#phase = "confirm-environments";
    this.#save();
    return this.discovery();
  }

  discovery(): OnboardingDiscovery | undefined {
    return this.#discovery && {
      environments: this.#discovery.environments.map((environment) => ({ ...environment })),
      sources: this.#discovery.sources.map((source) => ({ ...source })),
    };
  }

  reviseDiscovery(discovery: OnboardingDiscovery): OnboardingSnapshot {
    this.#expect("confirm-environments");
    assertSafeDiscovery(discovery);
    this.#discovery = {
      environments: discovery.environments.map((environment) => ({ ...environment })),
      sources: discovery.sources.map((source) => ({ ...source })),
    };
    return this.#save();
  }

  confirmEnvironments(confirmed: boolean): OnboardingSnapshot {
    this.#expect("confirm-environments");
    if (!confirmed) return this.snapshot();
    this.#environmentConfirmed = true;
    this.#phase = "triage";
    return this.#save();
  }

  selectSources(sourceIds: readonly string[]): OnboardingSnapshot {
    this.#expect("triage");
    if (!this.#environmentConfirmed || !this.#discovery) throw new Error("Environment set must be explicitly confirmed before source triage.");
    const selected = unique(sourceIds);
    const known = new Set(this.#discovery.sources.map(({ id }) => id));
    if (selected.some((id) => !known.has(id))) throw new Error("Selected history source was not discovered.");
    this.#selectedSourceIds = selected;
    this.#phase = "privacy";
    return this.#save();
  }

  consent(accepted: boolean): OnboardingSnapshot {
    this.#expect("privacy");
    if (!accepted) return this.cancel();
    this.#consented = true;
    this.#phase = "ready-to-scan";
    return this.#save();
  }

  cancel(): OnboardingSnapshot {
    this.#cancelled = true;
    this.#phase = "cancelled";
    return this.#save();
  }

  async scan(): Promise<OnboardingSnapshot> {
    if (this.#phase !== "ready-to-scan" && this.#phase !== "paused") this.#expect("ready-to-scan");
    if (!this.#environmentConfirmed || !this.#consented) throw new Error("Explicit environment confirmation and privacy consent are required before scanning.");
    let verifiedScrubbers: VerifiedScrubbers | void;
    try {
      verifiedScrubbers = await this.options.verifyScrubbers();
    } catch {
      this.#incidents = [];
      this.#phase = "paused";
      return this.#save();
    }
    let mined: IncidentManifest[] = [];
    const scope = this.#scope;
    if (!scope) throw new Error("Onboarding scope is missing.");
    const checkpointDirectory = join(guardHomeForScope(scope, this.options.environment, this.options.cwd), "scan");
    let loadedHistory: HistoryChunk[] | undefined;
    const result = await scanHistory(
      async () => {
        loadedHistory = await this.options.loadHistory(this.#selectedSourceIds, { confirmed: true, scrubbersVerified: true });
        return loadedHistory;
      },
      {
        ...this.options.scan,
        ...(verifiedScrubbers ? scrubberScanOptions(verifiedScrubbers) : {}),
        modelPass: async (candidates, semanticContext) => {
          const incidents = await this.options.scan.modelPass(candidates, semanticContext);
          assertSafeIncidents(incidents);
          return incidents;
        },
        checkpoint: { directory: checkpointDirectory, identity: this.#scanRunId, validateIncidents: assertSafeIncidents },
        publish: async (incidents) => { mined = incidents.map((incident) => ({ ...incident, evidence_refs: [...incident.evidence_refs] })); },
      },
    );
    if (result.status === "paused") {
      this.#incidents = [];
      this.#phase = "paused";
      return this.#save();
    }
    if (loadedHistory && this.options.incrementalCursor) {
      seedIncrementalCursor(
        this.options.incrementalCursor.directory,
        loadedHistory,
        this.options.incrementalCursor.maxSessionsPerSource,
      );
    }
    this.#incidents = mined;
    this.#phase = "review";
    return this.#save();
  }

  review(decisions: readonly GuardReviewDecision[]): OnboardingSnapshot {
    this.#expect("review");
    const byId = new Map(this.#incidents.map((incident) => [incident.incident_id, incident]));
    if (new Set(decisions.map(({ incidentId }) => incidentId)).size !== decisions.length) throw new Error("Each mined incident must have one review decision.");
    if (decisions.length !== this.#incidents.length || decisions.some(({ incidentId }) => !byId.has(incidentId))) {
      throw new Error("Every mined incident requires an explicit review decision.");
    }
    this.#approved = decisions.flatMap((decision) => {
      const incident = byId.get(decision.incidentId)!;
      if (!decision.approved) return [];
      return [{ incident, confidence: decision.confidence ?? (incident.severity >= 4 ? "high" : "low") }];
    });
    this.#phase = "ready-to-install";
    return this.#save();
  }

  async install(): Promise<OnboardingSnapshot> {
    this.#expect("ready-to-install");
    const guards = this.#approved.map(({ incident, confidence }) => compileGuard(incident, confidence));
    const runtime = new Runtime();
    if (guards.some((guard) => !runtime.evaluate([guard], syntheticEvent(guard)).fired)) {
      throw new Error("Compiled guard failed its synthetic proof; nothing was installed.");
    }
    const scope = this.#scope;
    if (!scope) throw new Error("Onboarding scope is missing.");
    const home = guardHomeForScope(scope, this.options.environment, this.options.cwd);
    const guardDirectory = join(home, "guards");
    if (!this.#discovery) throw new Error("Onboarding discovery is missing before binding install.");
    const environmentIds = unique(this.#discovery.environments.map(({ id }) => id));
    await this.options.installBindings(guards, environmentIds);
    applyAtomicFilePlans([
      ...guards.map((guard) => ({ path: join(guardDirectory, `${guard.id}.json`), content: `${JSON.stringify(guard)}\n` })),
      {
        path: join(guardDirectory, "proof.json"),
        content: `${JSON.stringify({ status: "pass", cases: guards.map((guard) => `synthetic event fired: ${guard.id}`) })}\n`,
      },
    ]);
    this.#installed = guards;
    this.#phase = "ready-to-prove";
    return this.#save();
  }

  prove(guardId = this.#installed[0]?.id): boolean {
    this.#expect("ready-to-prove");
    if (!guardId) {
      this.#phase = "complete";
      this.#save();
      return false;
    }
    const guard = this.#installed.find(({ id }) => id === guardId);
    if (!guard) throw new Error("Proof requested for an uninstalled guard.");
    const fired = new Runtime().evaluate([guard], syntheticEvent(guard)).fired;
    if (!fired) throw new Error("Installed guard failed proof replay.");
    this.#phase = "complete";
    this.#save();
    return true;
  }

  incidents(): IncidentManifest[] {
    return this.#incidents.map((incident) => ({ ...incident, evidence_refs: [...incident.evidence_refs] }));
  }

  #expect(phase: OnboardingPhase): void {
    if (this.#phase !== phase) throw new Error(`Onboarding is at ${this.#phase}; expected ${phase}.`);
  }

  #save(): OnboardingSnapshot {
    const snapshot = this.snapshot();
    this.options.save?.(this.checkpoint());
    return snapshot;
  }
}
