import { existsSync, readdirSync } from "node:fs";
import type { FiringEvent } from "../audit/firings";

export interface LocalStats {
  guards: number;
  receipts: number;
  firingsToday: number;
  firingsWeek: number;
}

const sevenDaysMilliseconds = 7 * 24 * 60 * 60 * 1000;

const emptyStats = (): LocalStats => ({ guards: 0, receipts: 0, firingsToday: 0, firingsWeek: 0 });

export function readLocalStats(
  guardDirectories: readonly string[],
  firingEvents: readonly Pick<FiringEvent, "firedAt">[] = [],
  now = new Date(),
): LocalStats {
  const stats = emptyStats();
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) throw new Error("Stats clock is invalid.");
  const today = now.toISOString().slice(0, 10);
  const weekStart = nowMilliseconds - sevenDaysMilliseconds;
  for (const event of firingEvents) {
    const firedAt = Date.parse(event.firedAt);
    if (!Number.isFinite(firedAt) || firedAt > nowMilliseconds) continue;
    if (event.firedAt.slice(0, 10) === today) stats.firingsToday += 1;
    if (firedAt >= weekStart) stats.firingsWeek += 1;
  }
  for (const directory of new Set(guardDirectories)) {
    try {
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        if (entry.name === "proof.json") stats.receipts += 1;
        else stats.guards += 1;
      }
    } catch {
      continue;
    }
  }
  return stats;
}
