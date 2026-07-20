import { ingestFailClosed, type IngestResult } from "../scrub/fail-closed";
import { createGitleaksCommandScrubber } from "../scrub/gitleaks";
import type { LocalOnlySink } from "../scrub/local-sink";
import { createPresidioCommandScrubber, type Scrubber } from "../scrub/presidio";
import { markScrubbedCandidates, type ScrubbedCandidates } from "../scrub/scrubbed-candidates";
import { candidateFingerprint, dedupeCandidates, type DedupedCandidate } from "./dedup";
import { prefilterCandidates } from "./prefilter";
import { planHybridScan, type HybridScanPlan } from "./hybrid";
import { readValidatedCheckpoint, writeCheckpoint } from "./resume";
import { runModelPass } from "../mine/model-pass";
import { retrieveScanSemanticContext, type ScanSemanticOptions, type UntrustedSemanticContext } from "./semantic-context";
import type { HistoryChunk } from "./types";

export interface ScanOptions<Incident> {
  presidioCommand: readonly string[];
  gitleaksCommand: readonly string[];
  /** In-process scrubbers. When present these win over the command form. */
  presidio?: Scrubber;
  gitleaks?: Scrubber;
  localSink: LocalOnlySink;
  modelPass(candidates: HistoryChunk[], semanticContext?: UntrustedSemanticContext): Promise<Incident[]>;
  publish(incidents: Incident[]): Promise<void>;
  checkpoint?: {
    directory: string;
    identity: string;
    validateIncidents(incidents: readonly Incident[]): void;
    onLegacyResume?(stage: "ingested" | "incidents"): void;
  };
  semantic?: ScanSemanticOptions;
  hybrid?: {
    backgroundOptIn?: boolean;
    queueBackground?(candidates: ScrubbedCandidates): Promise<void>;
    onPlan?(plan: Readonly<Omit<HybridScanPlan, "foreground" | "background"> & { foregroundCandidates: number; backgroundCandidates: number }>): void;
  };
}

interface IngestedCheckpoint {
  schemaVersion: 1;
  stage: "ingested";
  identity: string;
  plan: DedupedHybridPlan;
}

interface IncidentsCheckpoint<Incident> {
  schemaVersion: 1;
  stage: "incidents";
  identity: string;
  incidents: Incident[];
}

interface DedupedHybridPlan {
  offerBackground: boolean;
  foreground: DedupedCandidate[];
  background: DedupedCandidate[];
  totalSessions: number;
  foregroundSessions: number;
}

const checkpointSecret = /\bBearer\s+(?!<redacted>)\S+|\b(?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*(?!(?:Bearer\s+)?<redacted>)\S+|\b(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key));
}

function isDedupedCandidate(value: unknown): value is DedupedCandidate {
  if (!isRecord(value) || !hasExactKeys(value,
    ["source", "sessionId", "messageIndex", "chunkIndex", "role", "content", "fingerprint", "frequency", "evidenceRefs"],
    ["timestamp"],
  )) return false;
  return (value.source === "claude-code" || value.source === "codex" || value.source === "hermes")
    && typeof value.sessionId === "string"
    && Number.isInteger(value.messageIndex) && Number(value.messageIndex) >= 0
    && Number.isInteger(value.chunkIndex) && Number(value.chunkIndex) >= 0
    && typeof value.role === "string"
    && typeof value.content === "string"
    && (value.timestamp === undefined || typeof value.timestamp === "string")
    && typeof value.fingerprint === "string"
    && value.fingerprint === candidateFingerprint(value.content)
    && Number.isInteger(value.frequency) && Number(value.frequency) > 0
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.length === value.frequency
    && value.evidenceRefs.every((reference) => typeof reference === "string")
    && new Set(value.evidenceRefs).size === value.evidenceRefs.length
    && !checkpointSecret.test(JSON.stringify(value));
}

function isDedupedHybridPlan(value: unknown): value is DedupedHybridPlan {
  if (!(isRecord(value)
    && hasExactKeys(value, ["offerBackground", "foreground", "background", "totalSessions", "foregroundSessions"])
    && typeof value.offerBackground === "boolean"
    && Array.isArray(value.foreground) && value.foreground.every(isDedupedCandidate)
    && Array.isArray(value.background) && value.background.every(isDedupedCandidate)
    && Number.isInteger(value.totalSessions) && Number(value.totalSessions) >= 0
    && Number.isInteger(value.foregroundSessions) && Number(value.foregroundSessions) >= 0
    && Number(value.foregroundSessions) <= Number(value.totalSessions))) return false;
  const fingerprints = [...value.foreground, ...value.background].map(({ fingerprint }) => fingerprint);
  return new Set(fingerprints).size === fingerprints.length;
}

function isIngestedCheckpoint(value: unknown, identity: string): value is IngestedCheckpoint {
  return isRecord(value)
    && hasExactKeys(value, ["schemaVersion", "stage", "identity", "plan"])
    && value.schemaVersion === 1
    && value.stage === "ingested"
    && value.identity === identity
    && isDedupedHybridPlan(value.plan);
}

function isIncidentsCheckpoint<Incident>(value: unknown, identity: string, validate: (incidents: readonly Incident[]) => void): value is IncidentsCheckpoint<Incident> {
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "stage", "identity", "incidents"])
    || value.schemaVersion !== 1
    || value.stage !== "incidents"
    || value.identity !== identity
    || !Array.isArray(value.incidents)) return false;
  try {
    validate(value.incidents as Incident[]);
    return !checkpointSecret.test(JSON.stringify(value.incidents));
  } catch {
    return false;
  }
}

function checkpointCandidates(directory: string, identity: string, plan: DedupedHybridPlan): void {
  writeCheckpoint(directory, "ingested", { schemaVersion: 1, stage: "ingested", identity, plan } satisfies IngestedCheckpoint);
}

function checkpointIncidents<Incident>(directory: string, identity: string, incidents: Incident[], validate: (incidents: readonly Incident[]) => void): void {
  validate(incidents);
  if (checkpointSecret.test(JSON.stringify(incidents))) throw new Error("Incident checkpoint contains unsanitized secret material.");
  writeCheckpoint(directory, "incidents", { schemaVersion: 1, stage: "incidents", identity, incidents } satisfies IncidentsCheckpoint<Incident>);
  // Companion debug log: surfaces the accepted count alongside the
  // incidents checkpoint, so a "0 incidents" outcome is no longer a silent
  // dead end. The rejected list is reserved for a follow-up that captures
  // model-pass and parseIncidentManifest failures with reasons.
  writeCheckpoint(directory, "filter-log", {
    schemaVersion: 1,
    stage: "filter-log",
    identity,
    acceptedCount: incidents.length,
    rejected: [],
  });
}

function preparePlan(chunks: readonly HistoryChunk[], candidates: readonly HistoryChunk[], backgroundOptIn = false): DedupedHybridPlan {
  const rawPlan = planHybridScan(chunks, candidates, backgroundOptIn);
  const deduped = dedupeCandidates([...candidates]);
  const foregroundFingerprints = new Set(dedupeCandidates(rawPlan.foreground).map(({ fingerprint }) => fingerprint));
  return {
    offerBackground: rawPlan.offerBackground,
    foreground: deduped.filter(({ fingerprint }) => foregroundFingerprints.has(fingerprint)),
    background: deduped.filter(({ fingerprint }) => !foregroundFingerprints.has(fingerprint)),
    totalSessions: rawPlan.totalSessions,
    foregroundSessions: rawPlan.foregroundSessions,
  };
}

async function mineScrubbedCandidates<Incident>(plan: DedupedHybridPlan, options: ScanOptions<Incident>): Promise<Incident[]> {
  options.hybrid?.onPlan?.({
    offerBackground: plan.offerBackground,
    totalSessions: plan.totalSessions,
    foregroundSessions: plan.foregroundSessions,
    foregroundCandidates: plan.foreground.length,
    backgroundCandidates: plan.background.length,
  });
  if (plan.background.length) {
    if (!options.hybrid?.queueBackground) throw new Error("Background scan was selected but no local queue is configured.");
    await options.hybrid.queueBackground(markScrubbedCandidates(plan.background));
  }
  const scrubbedCandidates = markScrubbedCandidates(plan.foreground);
  const semanticContext = options.semantic
    ? await retrieveScanSemanticContext(scrubbedCandidates, options.semantic)
    : undefined;
  return runModelPass(scrubbedCandidates, options.modelPass, semanticContext);
}

export async function scanHistory<Incident>(
  chunksOrLoader: HistoryChunk[] | (() => Promise<HistoryChunk[]>),
  options: ScanOptions<Incident>,
): Promise<IngestResult> {
  const checkpoint = options.checkpoint;
  if (checkpoint) {
    if (/^(?:\\\\|\/\/)/.test(checkpoint.directory)) throw new Error("Scan checkpoint must use a local path.");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(checkpoint.identity)) throw new Error("Scan checkpoint identity is invalid.");
    const warnLegacy = checkpoint.onLegacyResume ?? ((stage: "ingested" | "incidents") => {
      process.stderr.write(`VibeBloat ignored legacy ${stage} checkpoint and resumed from the last validated stage.\n`);
    });
    const incidents = readValidatedCheckpoint(checkpoint.directory, "incidents", (value): value is IncidentsCheckpoint<Incident> =>
      isIncidentsCheckpoint(value, checkpoint.identity, checkpoint.validateIncidents));
    if (incidents.status === "valid") {
      await options.publish(incidents.value.incidents);
      return { status: "ingested" };
    }
    if (incidents.status === "legacy") warnLegacy("incidents");

    const ingested = readValidatedCheckpoint(checkpoint.directory, "ingested", (value): value is IngestedCheckpoint =>
      isIngestedCheckpoint(value, checkpoint.identity));
    if (ingested.status === "valid") {
      const mined = await mineScrubbedCandidates(ingested.value.plan, options);
      checkpointIncidents(checkpoint.directory, checkpoint.identity, mined, checkpoint.validateIncidents);
      await options.publish(mined);
      return { status: "ingested" };
    }
    if (ingested.status === "legacy") warnLegacy("ingested");
  }

  const chunks = typeof chunksOrLoader === "function" ? await chunksOrLoader() : chunksOrLoader;
  return ingestFailClosed(JSON.stringify(chunks), {
    presidio: options.presidio ?? createPresidioCommandScrubber(options.presidioCommand),
    gitleaks: options.gitleaks ?? createGitleaksCommandScrubber(options.gitleaksCommand),
    localSink: options.localSink,
    modelPass: async (payload) => {
      const scrubbedChunks = JSON.parse(payload) as HistoryChunk[];
      const plan = preparePlan(scrubbedChunks, prefilterCandidates(scrubbedChunks), options.hybrid?.backgroundOptIn);
      if (checkpoint) checkpointCandidates(checkpoint.directory, checkpoint.identity, plan);
      const incidents = await mineScrubbedCandidates(plan, options);
      if (checkpoint) checkpointIncidents(checkpoint.directory, checkpoint.identity, incidents, checkpoint.validateIncidents);
      return incidents;
    },
    publish: options.publish,
  });
}
