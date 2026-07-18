import { ingestFailClosed, type IngestResult } from "../scrub/fail-closed";
import { createGitleaksCommandScrubber } from "../scrub/gitleaks";
import type { LocalOnlySink } from "../scrub/local-sink";
import { createPresidioCommandScrubber } from "../scrub/presidio";
import { markScrubbedCandidates, type ScrubbedCandidates } from "../scrub/scrubbed-candidates";
import { prefilterCandidates } from "./prefilter";
import { planHybridScan, type HybridScanPlan } from "./hybrid";
import { runModelPass } from "../mine/model-pass";
import { retrieveScanSemanticContext, type ScanSemanticOptions, type UntrustedSemanticContext } from "./semantic-context";
import type { HistoryChunk } from "./types";

export interface ScanOptions<Incident> {
  presidioCommand: readonly string[];
  gitleaksCommand: readonly string[];
  localSink: LocalOnlySink;
  modelPass(candidates: HistoryChunk[], semanticContext?: UntrustedSemanticContext): Promise<Incident[]>;
  publish(incidents: Incident[]): Promise<void>;
  semantic?: ScanSemanticOptions;
  hybrid?: {
    backgroundOptIn?: boolean;
    queueBackground?(candidates: ScrubbedCandidates): Promise<void>;
    onPlan?(plan: Readonly<Omit<HybridScanPlan, "foreground" | "background"> & { foregroundCandidates: number; backgroundCandidates: number }>): void;
  };
}

export async function scanHistory<Incident>(chunks: HistoryChunk[], options: ScanOptions<Incident>): Promise<IngestResult> {
  return ingestFailClosed(JSON.stringify(chunks), {
    presidio: createPresidioCommandScrubber(options.presidioCommand),
    gitleaks: createGitleaksCommandScrubber(options.gitleaksCommand),
    localSink: options.localSink,
    modelPass: async (payload) => {
      const scrubbedChunks = JSON.parse(payload) as HistoryChunk[];
      const candidates = prefilterCandidates(scrubbedChunks);
      const plan = planHybridScan(scrubbedChunks, candidates, options.hybrid?.backgroundOptIn);
      options.hybrid?.onPlan?.({
        offerBackground: plan.offerBackground,
        totalSessions: plan.totalSessions,
        foregroundSessions: plan.foregroundSessions,
        foregroundCandidates: plan.foreground.length,
        backgroundCandidates: plan.background.length,
      });
      if (plan.background.length) {
        if (!options.hybrid?.queueBackground) throw new Error("Background scan was selected but no local queue is configured.");
        await options.hybrid.queueBackground(markScrubbedCandidates(plan.background));
      }
      const scrubbedCandidates = markScrubbedCandidates(plan.foreground);
      const semanticContext = options.semantic
        ? await retrieveScanSemanticContext(scrubbedCandidates, options.semantic)
        : undefined;
      return runModelPass(scrubbedCandidates, options.modelPass, semanticContext);
    },
    publish: options.publish,
  });
}
