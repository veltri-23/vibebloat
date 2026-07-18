import type { Action, Guard, GuardClass } from "./types";

const guardClasses = new Set<GuardClass>(["A", "B", "C", "D"]);
const actionTypes = new Set<Action["type"]>(["block", "warn", "require-confirm", "quarantine-file", "run-check"]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid guard: ${message}`);
}

export function parseGuard(value: unknown): Guard {
  assert(typeof value === "object" && value !== null, "must be an object");
  const guard = value as Partial<Guard>;
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
  assert(guard.action?.type !== "run-check" || typeof guard.action.check === "string", "run-check requires a check name");
  assert(typeof guard.enabled === "boolean", "enabled is required");
  return value as Guard;
}
