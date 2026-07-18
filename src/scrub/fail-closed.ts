import { scrubWithGitleaks } from "./gitleaks";
import { LocalOnlySink } from "./local-sink";
import { scrubWithPresidio, type Scrubber } from "./presidio";

export interface IngestOptions<Incident> {
  presidio: Scrubber;
  gitleaks: Scrubber;
  localSink: LocalOnlySink;
  modelPass(payload: string): Promise<Incident>;
  publish(incident: Incident): Promise<void>;
}

export type IngestResult =
  | { status: "ingested" }
  | { status: "paused"; message: "Scrub failed, ingest paused, fix and rerun" };

export async function ingestFailClosed<Incident>(rawPayload: string, options: IngestOptions<Incident>): Promise<IngestResult> {
  if (!(options.localSink instanceof LocalOnlySink)) throw new Error("A concrete local-only sink is required");
  let scrubbed: string;
  try {
    scrubbed = await scrubWithPresidio(rawPayload, options.presidio);
    scrubbed = await scrubWithGitleaks(scrubbed, options.gitleaks);
    if (typeof scrubbed !== "string") throw new Error("Scrubber returned invalid payload");
  } catch {
    await options.localSink.store(rawPayload);
    return { status: "paused", message: "Scrub failed, ingest paused, fix and rerun" };
  }
  const incident = await options.modelPass(scrubbed);
  await options.publish(incident);
  return { status: "ingested" };
}
