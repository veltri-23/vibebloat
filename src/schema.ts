import type { Action, Guard, GuardAgent, GuardClass } from "./types";

const guardClasses = new Set<GuardClass>(["A", "B", "C", "D"]);
const guardAgents = new Set<GuardAgent>(["claude-code", "codex", "hermes", "openclaw"]);
const actionTypes = new Set<Action["type"]>(["block", "warn", "require-confirm", "quarantine-file", "run-check"]);
const guardFields = new Set(["schemaVersion", "id", "class", "provenance", "match", "action", "confidence", "tier", "binds", "enabled"]);
const provenanceFields = new Set(["incident", "date", "source"]);
const matchFields = new Set(["chokepoint", "command", "argsContains", "argsAnyOf", "path"]);
const actionFields = new Set(["type", "message", "override"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid guard: ${message}`);
}

function record(value: unknown, message: string): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}

function assertAllowedFields(value: Record<string, unknown>, allowed: ReadonlySet<string>, scope: string): void {
  const unknown = Object.keys(value).find((field) => !allowed.has(field));
  assert(!unknown, `${scope} contains unknown field ${unknown}`);
}

export function parseGuard(value: unknown): Guard {
  const guardRecord = record(value, "must be an object");
  const guard = value as Partial<Guard>;
  const schemaVersion = guard.schemaVersion === undefined ? 1 : guard.schemaVersion;
  assert(schemaVersion === 1, "schemaVersion must be 1");
  assertAllowedFields(guardRecord, guardFields, "top-level guard");

  const provenance = record(guard.provenance, "provenance is required");
  const matcher = record(guard.match, "match is required");
  const action = record(guard.action, "action is required");
  assertAllowedFields(provenance, provenanceFields, "provenance");
  assertAllowedFields(matcher, matchFields, "match");

  assert(typeof guard.id === "string" && guard.id.length > 0, "id is required");
  assert(guardClasses.has(guard.class as GuardClass), "class must be A, B, C, or D");
  assert(typeof guard.provenance?.incident === "string", "provenance.incident is required");
  assert(typeof guard.provenance?.date === "string", "provenance.date is required");
  assert(typeof guard.provenance?.source === "string", "provenance.source is required");
  assert(guard.match?.chokepoint === "shell" || guard.match?.chokepoint === "file", "match.chokepoint is required");
  assert(!guard.match?.argsContains || guard.match.argsContains.every((argument) => typeof argument === "string" && argument.length > 0), "match.argsContains must contain non-empty strings");
  assert(!guard.match?.argsAnyOf || guard.match.argsAnyOf.every((argument) => typeof argument === "string" && argument.length > 0), "match.argsAnyOf must contain non-empty strings");
  assert(typeof guard.action?.message === "string", "action.message is required");
  assert(typeof guard.action?.override === "string", "action.override is required");
  assert(actionTypes.has(guard.action?.type as Action["type"]), "action.type is not trusted");
  const allowedActionFields = new Set(actionFields);
  if (guard.action?.type === "quarantine-file") allowedActionFields.add("quarantinePath");
  if (guard.action?.type === "run-check") allowedActionFields.add("check");
  assertAllowedFields(action, allowedActionFields, "action");
  assert(guard.action?.type !== "run-check" || typeof guard.action.check === "string", "run-check requires a check name");
  assert(typeof guard.enabled === "boolean", "enabled is required");
  assert(guard.binds === undefined || (Array.isArray(guard.binds) && guard.binds.every((agent) => guardAgents.has(agent))), "binds must contain known agents");
  return value as Guard;
}
