import { scrubWithGitleaks } from "./gitleaks";
import { scrubWithPresidio, type Scrubber } from "./presidio";

export interface IngestOptions<Incident> {
  presidio: Scrubber;
  gitleaks: Scrubber;
  storeLocal(payload: string): Promise<void>;
  modelPass(payload: string): Promise<Incident>;
  publish(incident: Incident): Promise<void>;
}

export type IngestResult =
  | { status: "ingested" }
  | { status: "paused"; message: "Scrub failed, ingest paused, fix and rerun" };

export async function ingestFailClosed<Incident>(rawPayload: string, options: IngestOptions<Incident>): Promise<IngestResult> {
  let scrubbed: string;
  try {
    scrubbed = await scrubWithPresidio(rawPayload, options.presidio);
    scrubbed = await scrubWithGitleaks(scrubbed, options.gitleaks);
    if (typeof scrubbed !== "string") throw new Error("Scrubber returned invalid payload");
  } catch {
    await options.storeLocal(rawPayload);
    return { status: "paused", message: "Scrub failed, ingest paused, fix and rerun" };
  }
  const incident = await options.modelPass(scrubbed);
  await options.publish(incident);
  return { status: "ingested" };
}
