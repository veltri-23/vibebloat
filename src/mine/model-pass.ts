import type { HistoryChunk } from "../ingest/types";

export type ModelPass<Incident> = (candidates: HistoryChunk[]) => Promise<Incident[]>;

export async function runModelPass<Incident>(candidates: HistoryChunk[], mine: ModelPass<Incident>): Promise<Incident[]> {
  return mine(candidates);
}
