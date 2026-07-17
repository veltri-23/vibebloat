import { ingestFailClosed, type IngestResult } from "../scrub/fail-closed";
import type { Scrubber } from "../scrub/presidio";
import { prefilterCandidates } from "./prefilter";
import type { HistoryChunk } from "./types";

export interface ScanOptions<Incident> {
  presidio: Scrubber;
  gitleaks: Scrubber;
  storeLocal(payload: string): Promise<void>;
  modelPass(candidates: HistoryChunk[]): Promise<Incident[]>;
  publish(incidents: Incident[]): Promise<void>;
}

export async function scanHistory<Incident>(chunks: HistoryChunk[], options: ScanOptions<Incident>): Promise<IngestResult> {
  return ingestFailClosed(JSON.stringify(chunks), {
    presidio: options.presidio,
    gitleaks: options.gitleaks,
    storeLocal: options.storeLocal,
    modelPass: async (payload) => options.modelPass(prefilterCandidates(JSON.parse(payload) as HistoryChunk[])),
    publish: options.publish,
  });
}
