import { join } from "node:path";
import { compileGuard } from "../compiler/codex-fill";
import { guardHomeForScope, type GuardScope } from "../guard-home";
import { scanHistory, type ScanOptions } from "../ingest/scan";
import type { IncidentManifest } from "../ingest/rank";
import type { HistoryChunk } from "../ingest/types";
import { applyAtomicFilePlans } from "../install/atomic-files";
import { Runtime } from "../runtime";
import type { Event, Guard } from "../types";
import { renderGate, type GateId } from "./gates";

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

export interface OnboardingCoordinatorOptions {
  discover(): Promise<OnboardingDiscovery>;
  verifyScrubbers(): Promise<void> | void;
  loadHistory(sourceIds: readonly string[], authorization: { confirmed: true; scrubbersVerified: true }): Promise<HistoryChunk[]>;
  scan: Omit<ScanOptions<IncidentManifest>, "publish">;
  installBindings(guards: readonly Guard[]): Promise<void> | void;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  save?(snapshot: OnboardingSnapshot): void;
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
  const serialized = JSON.stringify(incident);
  if (rawSecret.test(serialized)) throw new Error("Mined incident contains unsanitized secret material.");
  if (email.test(serialized)) throw new Error("Mined incident contains personal data.");
  if (embeddedAbsolutePath.test(serialized)) throw new Error("Mined incident contains an absolute path.");
  if (incident.path && absolutePath.test(incident.path)) throw new Error("Mined incident path must be repository-relative.");
  if (incident.evidence_refs.some((reference) => absolutePath.test(reference))) throw new Error("Mined incident evidence must not contain absolute paths.");
  compileGuard(incident, incident.severity >= 4 ? "high" : "low");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
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

  constructor(private readonly options: OnboardingCoordinatorOptions) {}

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
    const discovery = await this.options.discover();
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
    this.#expect("ready-to-scan");
    if (!this.#environmentConfirmed || !this.#consented) throw new Error("Explicit environment confirmation and privacy consent are required before scanning.");
    try {
      await this.options.verifyScrubbers();
    } catch {
      this.#incidents = [];
      this.#phase = "paused";
      return this.#save();
    }
    const chunks = await this.options.loadHistory(this.#selectedSourceIds, { confirmed: true, scrubbersVerified: true });
    let mined: IncidentManifest[] = [];
    const result = await scanHistory(chunks, {
      ...this.options.scan,
      modelPass: async (candidates, semanticContext) => {
        const incidents = await this.options.scan.modelPass(candidates, semanticContext);
        incidents.forEach(assertSafeIncident);
        return incidents;
      },
      publish: async (incidents) => { mined = incidents.map((incident) => ({ ...incident, evidence_refs: [...incident.evidence_refs] })); },
    });
    if (result.status === "paused") {
      this.#incidents = [];
      this.#phase = "paused";
      return this.#save();
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
    await this.options.installBindings(guards);
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
    this.options.save?.(snapshot);
    return snapshot;
  }
}
