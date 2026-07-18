import type { Guard } from "../types";

export type ExecutableGuardField = "class" | "match" | "action" | "binds" | "enabled";

export interface ChangedGuard {
  id: string;
  fields: ExecutableGuardField[];
}

export interface CommunityGuardDiff {
  added: string[];
  changed: ChangedGuard[];
  removed: string[];
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function manifest(guards: readonly Guard[]): Map<string, Guard> {
  const result = new Map<string, Guard>();
  for (const guard of guards) {
    if (guard.tier !== "community") throw new Error(`Update manifest guard ${guard.id} is not community tier.`);
    if (result.has(guard.id)) throw new Error(`Update manifest contains duplicate guard id: ${guard.id}`);
    result.set(guard.id, guard);
  }
  return result;
}

export function diffCommunityGuards(current: readonly Guard[], candidate: readonly Guard[]): CommunityGuardDiff {
  const currentById = manifest(current);
  const candidateById = manifest(candidate);
  const added = [...candidateById.keys()].filter((id) => !currentById.has(id)).sort();
  const removed = [...currentById.keys()].filter((id) => !candidateById.has(id)).sort();
  const changed: ChangedGuard[] = [];

  for (const id of [...candidateById.keys()].filter((guardId) => currentById.has(guardId)).sort()) {
    const before = currentById.get(id)!;
    const after = candidateById.get(id)!;
    const fields = (["class", "match", "action", "binds", "enabled"] as const)
      .filter((field) => canonical(before[field]) !== canonical(after[field]));
    if (fields.length) changed.push({ id, fields: [...fields] });
  }

  return { added, changed, removed };
}

function list(values: readonly string[]): string {
  return values.length ? values.join(", ") : "none";
}

export function formatGuardDiff(currentVersion: string, candidateVersion: string, diff: CommunityGuardDiff): string {
  return [
    `VibeBloat update available: ${currentVersion} -> ${candidateVersion}`,
    `Guards: ${diff.added.length} added / ${diff.changed.length} changed / ${diff.removed.length} removed`,
    `Added: ${list(diff.added)}`,
    `Changed: ${list(diff.changed.map((guard) => `${guard.id} [${guard.fields.join(", ")}]`))}`,
    `Removed: ${list(diff.removed)}`,
    "Apply: vibebloat update --apply",
  ].join("\n");
}
