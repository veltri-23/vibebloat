import type { Action, Guard, GuardAgent, GuardClass } from "./types";

const guardClasses = new Set<GuardClass>(["A", "B", "C", "D"]);
const guardAgents = new Set<GuardAgent>(["claude-code", "codex", "hermes", "openclaw"]);
const actionTypes = new Set<Action["type"]>(["block", "warn", "require-confirm", "quarantine-file", "run-check"]);
const guardFields = new Set(["schemaVersion", "id", "class", "provenance", "match", "action", "confidence", "tier", "binds", "enabled"]);
const provenanceFields = new Set(["incident", "date", "source"]);
const matchFields = new Set(["chokepoint", "command", "argsContains", "argsAnyOf", "path"]);
const actionFields = new Set(["type", "message", "override"]);
const guardIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertOptionalStringArray(value: unknown, field: string): void {
  assert(value === undefined || (Array.isArray(value) && value.every(isNonEmptyString)), `${field} must be an array of non-empty strings`);
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

  assert(isNonEmptyString(guard.id) && guardIdPattern.test(guard.id), "id must use lower-case kebab-case");
  assert(guardClasses.has(guard.class as GuardClass), "class must be A, B, C, or D");
  assert(isNonEmptyString(guard.provenance?.incident), "provenance.incident must be a non-empty string");
  assert(isNonEmptyString(guard.provenance?.date), "provenance.date must be a non-empty string");
  assert(isNonEmptyString(guard.provenance?.source), "provenance.source must be a non-empty string");
  assert(guard.match?.chokepoint === "shell" || guard.match?.chokepoint === "file", "match.chokepoint is required");
  assert(guard.match.command === undefined || isNonEmptyString(guard.match.command), "match.command must be a non-empty string");
  assert(guard.match.path === undefined || isNonEmptyString(guard.match.path), "match.path must be a non-empty string");
  assert(guard.match.chokepoint !== "shell" || isNonEmptyString(guard.match.command), "shell match requires a non-empty command");
  assert(guard.match.chokepoint !== "file" || isNonEmptyString(guard.match.path), "file match requires a non-empty path");
  assertOptionalStringArray(guard.match.argsContains, "match.argsContains");
  assertOptionalStringArray(guard.match.argsAnyOf, "match.argsAnyOf");
  assert(isNonEmptyString(guard.action?.message), "action.message must be a non-empty string");
  assert(isNonEmptyString(guard.action?.override), "action.override must be a non-empty string");
  assert(actionTypes.has(guard.action?.type as Action["type"]), "action.type is not trusted");
  const allowedActionFields = new Set(actionFields);
  if (guard.action?.type === "quarantine-file") allowedActionFields.add("quarantinePath");
  if (guard.action?.type === "run-check") allowedActionFields.add("check");
  assertAllowedFields(action, allowedActionFields, "action");
  assert(guard.action?.type !== "quarantine-file" || isNonEmptyString(guard.action.quarantinePath), "quarantine-file requires a non-empty quarantinePath");
  assert(guard.action?.type !== "run-check" || isNonEmptyString(guard.action.check), "run-check requires a non-empty check name");
  assert(guard.confidence === undefined || guard.confidence === "high" || guard.confidence === "low", "confidence must be high or low");
  assert(guard.tier === undefined || guard.tier === "local" || guard.tier === "community", "tier must be local or community");
  assert(typeof guard.enabled === "boolean", "enabled is required");
  assert(guard.binds === undefined || (Array.isArray(guard.binds) && guard.binds.every((agent) => guardAgents.has(agent))), "binds must be an array of known agents");
  assert(guard.binds === undefined || new Set(guard.binds).size === guard.binds.length, "binds must not contain duplicates");
  return value as Guard;
}
