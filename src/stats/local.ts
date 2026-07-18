import { existsSync, readdirSync } from "node:fs";

export interface LocalStats {
  guards: number;
  receipts: number;
}

const emptyStats = (): LocalStats => ({ guards: 0, receipts: 0 });

export function readLocalStats(guardDirectories: readonly string[]): LocalStats {
  const stats = emptyStats();
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
