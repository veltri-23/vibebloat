import { ingestFailClosed, type IngestResult } from "../scrub/fail-closed";
import { createGitleaksCommandScrubber } from "../scrub/gitleaks";
import type { LocalOnlySink } from "../scrub/local-sink";
import { createPresidioCommandScrubber } from "../scrub/presidio";
import { markScrubbedCandidates } from "../scrub/scrubbed-candidates";
import { prefilterCandidates } from "./prefilter";
import { runModelPass } from "../mine/model-pass";
import type { HistoryChunk } from "./types";

export interface ScanOptions<Incident> {
  presidioCommand: readonly string[];
  gitleaksCommand: readonly string[];
  localSink: LocalOnlySink;
  modelPass(candidates: HistoryChunk[]): Promise<Incident[]>;
  publish(incidents: Incident[]): Promise<void>;
}

export async function scanHistory<Incident>(chunks: HistoryChunk[], options: ScanOptions<Incident>): Promise<IngestResult> {
  return ingestFailClosed(JSON.stringify(chunks), {
    presidio: createPresidioCommandScrubber(options.presidioCommand),
    gitleaks: createGitleaksCommandScrubber(options.gitleaksCommand),
    localSink: options.localSink,
    modelPass: async (payload) => runModelPass(markScrubbedCandidates(prefilterCandidates(JSON.parse(payload) as HistoryChunk[])), options.modelPass),
    publish: options.publish,
  });
}
