import { compileGuard } from "../compiler/codex-fill";
import { syntheticEvent } from "../compiler/synthetic-event";
import { rankIncidents, type IncidentManifest } from "../ingest/rank";
import { prefilterCandidates } from "../ingest/prefilter";
import { match } from "../match";
import { renderGuardReceipt } from "../block-receipt";
import { builtinPresidioScrubber, builtinGitleaksScrubber } from "../scrub/builtin";
import type { HistoryChunk } from "../ingest/types";
import { sampleHistory, samplePrecomputedIncidents, SAMPLE_LABEL } from "./history";

export interface DemoStep {
  label: string;
  detail: string;
}

export interface DemoResult {
  steps: DemoStep[];
  receipts: string[];
  mined: "model" | "precomputed";
  incidents: IncidentManifest[];
}

export type DemoMiner = (candidates: HistoryChunk[]) => Promise<IncidentManifest[]>;

/**
 * Runs the real pipeline over the sample corpus so someone with no history of
 * their own can still see the whole loop end to end.
 *
 * Scrubbing, prefiltering, compiling and matching are the production code
 * paths, not a script. Only the mining step falls back: with no model
 * configured it uses the corpus's precomputed findings, and reports that it
 * did, because presenting canned findings as a live result would be exactly
 * the dishonesty this product is built against.
 */
export async function runSampleDemo(miner?: DemoMiner): Promise<DemoResult> {
  const history = sampleHistory();
  const steps: DemoStep[] = [{ label: "read", detail: `${history.length} messages across ${new Set(history.map((chunk) => chunk.sessionId)).size} sessions (${SAMPLE_LABEL})` }];

  const presidio = builtinPresidioScrubber();
  const gitleaks = builtinGitleaksScrubber();
  const scrubbed: HistoryChunk[] = [];
  for (const chunk of history) {
    scrubbed.push({ ...chunk, content: await gitleaks(await presidio(chunk.content)) });
  }
  steps.push({ label: "scrub", detail: "secrets removed before anything reaches a model" });

  const candidates = prefilterCandidates(scrubbed);
  steps.push({ label: "prefilter", detail: `${candidates.length} of ${scrubbed.length} messages carry an incident signal` });

  let incidents: IncidentManifest[] = [];
  let mined: DemoResult["mined"] = "precomputed";
  let minerError: string | undefined;
  if (miner) {
    try {
      incidents = await miner(candidates);
      mined = "model";
    } catch (error) {
      // A stale key or an offline endpoint must not take the demo down with
      // it: showing the loop is the whole point of this command.
      minerError = error instanceof Error ? error.message : "model command failed";
    }
  }
  if (mined === "model") {
    steps.push({ label: "mine", detail: `model found ${incidents.length} repeated ${incidents.length === 1 ? "mistake" : "mistakes"}` });
  } else {
    incidents = samplePrecomputedIncidents();
    steps.push({
      label: "mine",
      detail: minerError
        ? `model failed (${minerError}), using the sample's ${incidents.length} precomputed findings`
        : `no model configured, using the sample's ${incidents.length} precomputed findings`,
    });
  }

  const ranked = rankIncidents(incidents);
  const receipts: string[] = [];
  for (const incident of ranked) {
    const guard = compileGuard(incident, incident.severity >= 4 ? "high" : "low");
    const verdict = match(guard, syntheticEvent(guard));
    if (!verdict.fired) continue;
    const receipt = renderGuardReceipt(guard, verdict.reason ?? guard.action.message);
    if (receipt) receipts.push(receipt);
  }
  steps.push({ label: "prove", detail: `${receipts.length} ${receipts.length === 1 ? "guard blocks" : "guards block"} the exact command that caused the incident` });

  return { steps, receipts, mined, incidents: ranked };
}
