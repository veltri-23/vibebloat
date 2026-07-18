import { isScrubbedCandidates, type ScrubbedCandidates } from "../scrub/scrubbed-candidates";
import { isUntrustedSemanticContext, type UntrustedSemanticContext } from "../ingest/semantic-context";

export type ModelPass<Incident> = (candidates: ScrubbedCandidates["candidates"], semanticContext?: UntrustedSemanticContext) => Promise<Incident[]>;

export async function runModelPass<Incident>(scrubbed: ScrubbedCandidates, mine: ModelPass<Incident>, semanticContext?: UntrustedSemanticContext): Promise<Incident[]> {
  if (!isScrubbedCandidates(scrubbed)) throw new Error("Model pass requires scrubbed candidates");
  if (semanticContext !== undefined && !isUntrustedSemanticContext(semanticContext)) throw new Error("Model pass requires validated semantic context");
  return mine(scrubbed.candidates, semanticContext);
}
