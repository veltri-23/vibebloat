import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";
import type { ActionType, Chokepoint, GuardAgent, GuardClass } from "../types";

const retentionMilliseconds = 30 * 24 * 60 * 60 * 1000;
const guardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const guardClasses = new Set<GuardClass>(["A", "B", "C", "D"]);
const chokepoints = new Set<Chokepoint>(["shell", "file"]);
const actionTypes = new Set<ActionType>(["block", "warn", "require-confirm", "quarantine-file", "run-check"]);
const agents = new Set<GuardAgent>(["claude-code", "codex", "hermes", "openclaw"]);
const metadataFields = new Set(["guardId", "class", "chokepoint", "actionType", "blocked", "agent"]);
const eventFields = new Set(["schemaVersion", "eventId", "firedAt", ...metadataFields]);
const lastFiredFields = new Set(["schemaVersion", "guardId", "lastFiredAt"]);

export interface FiringMetadata {
  guardId: string;
  class: GuardClass;
  chokepoint: Chokepoint;
  actionType: ActionType;
  blocked: boolean;
  agent?: GuardAgent;
}

export interface FiringEvent extends FiringMetadata {
  schemaVersion: 1;
  eventId: string;
  firedAt: string;
}

export interface AuditWarning {
  what: string;
  why: string;
  fix: string;
}

export interface AuditSweepResult {
  events: FiringEvent[];
  pruned: number;
  quarantined: number;
  warnings: AuditWarning[];
}

export interface LastFiredSummary {
  schemaVersion: 1;
  guardId: string;
  lastFiredAt: string;
}

export interface LastFiredSweepResult {
  summaries: LastFiredSummary[];
  quarantined: number;
  warnings: AuditWarning[];
}

export type AppendFiringResult =
  | { status: "skipped"; warnings: [] }
  | { status: "appended"; event: FiringEvent; warnings: AuditWarning[] };

function firingsDirectory(globalHome: string): string {
  return join(globalHome, "audit", "firings");
}

function quarantineDirectory(globalHome: string): string {
  return join(globalHome, "audit", "quarantine", "firings");
}

function lastFiredDirectory(globalHome: string): string {
  return join(globalHome, "audit", "last-fired");
}

function lastFiredQuarantineDirectory(globalHome: string): string {
  return join(globalHome, "audit", "quarantine", "last-fired");
}

function secureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
}

function warning(error: unknown, what = "Audit retention cleanup failed."): AuditWarning {
  return {
    what,
    why: error instanceof Error ? error.message : "unknown error",
    fix: "vibebloat doctor",
  };
}

function assertExactFields(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error("Audit data contains a forbidden field.");
}

function parseMetadata(value: unknown): FiringMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audit metadata must be an object.");
  const metadata = value as Record<string, unknown>;
  assertExactFields(metadata, metadataFields);
  if (typeof metadata.guardId !== "string" || !guardIdPattern.test(metadata.guardId)) throw new Error("Audit guardId is invalid.");
  if (!guardClasses.has(metadata.class as GuardClass)) throw new Error("Audit class is invalid.");
  if (!chokepoints.has(metadata.chokepoint as Chokepoint)) throw new Error("Audit chokepoint is invalid.");
  if (!actionTypes.has(metadata.actionType as ActionType)) throw new Error("Audit actionType is invalid.");
  if (typeof metadata.blocked !== "boolean") throw new Error("Audit blocked value is invalid.");
  if (metadata.agent !== undefined && !agents.has(metadata.agent as GuardAgent)) throw new Error("Audit agent is invalid.");
  return metadata as unknown as FiringMetadata;
}

function parseEvent(value: unknown): FiringEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audit event must be an object.");
  const event = value as Record<string, unknown>;
  assertExactFields(event, eventFields);
  if (event.schemaVersion !== 1) throw new Error("Audit schemaVersion is invalid.");
  if (typeof event.eventId !== "string" || !uuidPattern.test(event.eventId)) throw new Error("Audit eventId is invalid.");
  if (typeof event.firedAt !== "string") throw new Error("Audit firedAt is invalid.");
  const firedAt = new Date(event.firedAt);
  if (!Number.isFinite(firedAt.getTime()) || firedAt.toISOString() !== event.firedAt) throw new Error("Audit firedAt is invalid.");
  return { schemaVersion: 1, eventId: event.eventId, firedAt: event.firedAt, ...parseMetadata(Object.fromEntries(Object.entries(event).filter(([field]) => metadataFields.has(field)))) };
}

function parseLastFiredSummary(value: unknown): LastFiredSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audit last-fired summary must be an object.");
  const summary = value as Record<string, unknown>;
  assertExactFields(summary, lastFiredFields);
  if (summary.schemaVersion !== 1) throw new Error("Audit last-fired schemaVersion is invalid.");
  if (typeof summary.guardId !== "string" || !guardIdPattern.test(summary.guardId)) throw new Error("Audit last-fired guardId is invalid.");
  if (typeof summary.lastFiredAt !== "string") throw new Error("Audit lastFiredAt is invalid.");
  const lastFiredAt = new Date(summary.lastFiredAt);
  if (!Number.isFinite(lastFiredAt.getTime()) || lastFiredAt.toISOString() !== summary.lastFiredAt) throw new Error("Audit lastFiredAt is invalid.");
  return { schemaVersion: 1, guardId: summary.guardId, lastFiredAt: summary.lastFiredAt };
}

function quarantine(globalHome: string, path: string): void {
  const directory = quarantineDirectory(globalHome);
  secureDirectory(directory);
  renameSync(path, join(directory, `${basename(path, ".json")}-${randomUUID()}.json`));
}

function quarantineLastFired(globalHome: string, path: string): void {
  const directory = lastFiredQuarantineDirectory(globalHome);
  secureDirectory(directory);
  renameSync(path, join(directory, `${basename(path, ".json")}-${randomUUID()}.json`));
}

function validNow(now: Date): number {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Audit clock is invalid.");
  return milliseconds;
}

export function readAndPruneFirings(globalHome: string, now = new Date()): AuditSweepResult {
  const directory = firingsDirectory(globalHome);
  const result: AuditSweepResult = { events: [], pruned: 0, quarantined: 0, warnings: [] };
  const nowMilliseconds = validNow(now);
  if (!existsSync(directory)) return result;
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch (error) {
    result.warnings.push(warning(error));
    return result;
  }
  for (const file of files) {
    const path = join(directory, file);
    let event: FiringEvent;
    try {
      if (!statSync(path).isFile()) throw new Error("Audit event is not a file.");
      event = parseEvent(JSON.parse(readFileSync(path, "utf8")));
      if (`${event.eventId}.json` !== file) throw new Error("Audit filename does not match eventId.");
    } catch (error) {
      try {
        quarantine(globalHome, path);
        result.quarantined += 1;
      } catch (quarantineError) {
        result.warnings.push(warning(quarantineError instanceof Error ? quarantineError : error));
      }
      continue;
    }
    const firedAt = Date.parse(event.firedAt);
    if (firedAt > nowMilliseconds) {
      try {
        quarantine(globalHome, path);
        result.quarantined += 1;
      } catch (error) {
        result.warnings.push(warning(error));
      }
    } else if (firedAt <= nowMilliseconds - retentionMilliseconds) {
      try {
        unlinkSync(path);
        result.pruned += 1;
      } catch (error) {
        result.warnings.push(warning(error));
      }
    } else {
      result.events.push(event);
    }
  }
  result.events.sort((left, right) => left.firedAt.localeCompare(right.firedAt));
  return result;
}

export function readLastFiredSummaries(globalHome: string, now = new Date()): LastFiredSweepResult {
  const directory = lastFiredDirectory(globalHome);
  const result: LastFiredSweepResult = { summaries: [], quarantined: 0, warnings: [] };
  const nowMilliseconds = validNow(now);
  if (!existsSync(directory)) return result;
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch (error) {
    result.warnings.push(warning(error, "Audit last-fired summary read failed."));
    return result;
  }
  for (const file of files) {
    const path = join(directory, file);
    try {
      if (!statSync(path).isFile()) throw new Error("Audit last-fired summary is not a file.");
      const summary = parseLastFiredSummary(JSON.parse(readFileSync(path, "utf8")));
      if (`${summary.guardId}.json` !== file) throw new Error("Audit last-fired filename does not match guardId.");
      if (Date.parse(summary.lastFiredAt) > nowMilliseconds) throw new Error("Audit last-fired timestamp is in the future.");
      result.summaries.push(summary);
    } catch (error) {
      try {
        quarantineLastFired(globalHome, path);
        result.quarantined += 1;
      } catch (quarantineError) {
        result.warnings.push(warning(quarantineError instanceof Error ? quarantineError : error, "Audit last-fired summary quarantine failed."));
      }
    }
  }
  result.summaries.sort((left, right) => left.guardId.localeCompare(right.guardId));
  return result;
}

function updateLastFiredSummary(globalHome: string, event: FiringEvent): void {
  const directory = lastFiredDirectory(globalHome);
  secureDirectory(directory);
  const path = join(directory, `${event.guardId}.json`);
  if (existsSync(path)) {
    try {
      const current = parseLastFiredSummary(JSON.parse(readFileSync(path, "utf8")));
      if (current.guardId !== event.guardId) throw new Error("Audit last-fired filename does not match guardId.");
      if (current.lastFiredAt >= event.firedAt) return;
    } catch {
      quarantineLastFired(globalHome, path);
    }
  }
  const summary: LastFiredSummary = { schemaVersion: 1, guardId: event.guardId, lastFiredAt: event.firedAt };
  replaceGuardAtomically(path, `${JSON.stringify(summary)}\n`);
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

export function appendFiring(
  globalHome: string,
  fired: boolean,
  metadata: unknown,
  now = new Date(),
): AppendFiringResult {
  if (!fired) return { status: "skipped", warnings: [] };
  const parsed = parseMetadata(metadata);
  const firedAt = new Date(validNow(now)).toISOString();
  const event: FiringEvent = { schemaVersion: 1, eventId: randomUUID(), firedAt, ...parsed };
  const directory = firingsDirectory(globalHome);
  secureDirectory(directory);
  const path = join(directory, `${event.eventId}.json`);
  replaceGuardAtomically(path, `${JSON.stringify(event)}\n`);
  const warnings: AuditWarning[] = [];
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      warnings.push(warning(error, "Audit file permission hardening failed."));
    }
  }
  try {
    updateLastFiredSummary(globalHome, event);
  } catch (error) {
    warnings.push(warning(error, "Audit last-fired summary update failed."));
  }
  warnings.push(...readAndPruneFirings(globalHome, now).warnings);
  return { status: "appended", event, warnings };
}

export function createFiringRecorder(globalHome: string): (metadata: FiringMetadata) => AuditWarning[] {
  return (metadata) => {
    const result = appendFiring(globalHome, true, metadata);
    return result.status === "appended" ? result.warnings : [];
  };
}
