import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { applyAtomicFilePlans } from "../install/atomic-files";

export type CustomAgentHomeId = "claude-code" | "codex" | "hermes";
export type CustomAgentHomes = Partial<Record<CustomAgentHomeId, string>>;

interface CustomAgentHomeReceipt {
  schemaVersion: 1;
  owner: "vibebloat";
  homes: CustomAgentHomes;
}

const ids = new Set<CustomAgentHomeId>(["claude-code", "codex", "hermes"]);

function receiptPath(directory: string): string {
  return join(resolve(directory), "custom-agent-homes.json");
}

function verifiedDirectory(path: string): string {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error("Custom agent home must be an existing absolute directory.");
  const canonical = realpathSync(path);
  const stat = lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Custom agent home must be a real directory.");
  return canonical;
}

export function readCustomAgentHomes(directory: string): CustomAgentHomes {
  const path = receiptPath(directory);
  if (!existsSync(path)) return {};
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Custom agent home receipt is unsafe.");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Custom agent home receipt is invalid.");
  const receipt = value as Partial<CustomAgentHomeReceipt>;
  if (receipt.schemaVersion !== 1 || receipt.owner !== "vibebloat" || !receipt.homes || typeof receipt.homes !== "object" || Array.isArray(receipt.homes)) {
    throw new Error("Custom agent home receipt is invalid.");
  }
  const homes: CustomAgentHomes = {};
  for (const [id, candidate] of Object.entries(receipt.homes)) {
    if (!ids.has(id as CustomAgentHomeId) || typeof candidate !== "string") throw new Error("Custom agent home receipt is invalid.");
    homes[id as CustomAgentHomeId] = verifiedDirectory(candidate);
  }
  return homes;
}

export function saveCustomAgentHome(directory: string, id: CustomAgentHomeId, home: string): CustomAgentHomes {
  const homes = { ...readCustomAgentHomes(directory), [id]: verifiedDirectory(home) };
  const receipt: CustomAgentHomeReceipt = { schemaVersion: 1, owner: "vibebloat", homes };
  applyAtomicFilePlans([{ path: receiptPath(directory), content: `${JSON.stringify(receipt)}\n`, mode: 0o600 }]);
  return homes;
}

export function revokeCustomAgentHomes(directory: string, identifiers: readonly string[]): CustomAgentHomes {
  const revoked = new Set(identifiers.filter((id): id is CustomAgentHomeId => ids.has(id as CustomAgentHomeId)));
  const homes = Object.fromEntries(Object.entries(readCustomAgentHomes(directory)).filter(([id]) => !revoked.has(id))) as CustomAgentHomes;
  const receipt: CustomAgentHomeReceipt = { schemaVersion: 1, owner: "vibebloat", homes };
  applyAtomicFilePlans([{ path: receiptPath(directory), content: `${JSON.stringify(receipt)}\n`, mode: 0o600 }]);
  return homes;
}
