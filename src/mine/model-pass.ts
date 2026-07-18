import { isScrubbedCandidates, type ScrubbedCandidates } from "../scrub/scrubbed-candidates";

export type ModelPass<Incident> = (candidates: ScrubbedCandidates["candidates"]) => Promise<Incident[]>;

export async function runModelPass<Incident>(scrubbed: ScrubbedCandidates, mine: ModelPass<Incident>): Promise<Incident[]> {
  if (!isScrubbedCandidates(scrubbed)) throw new Error("Model pass requires scrubbed candidates");
  return mine(scrubbed.candidates);
}
