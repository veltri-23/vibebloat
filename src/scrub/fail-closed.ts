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
  | { status: "ingested"; quarantined?: number }
  | { status: "paused"; message: "Scrub failed, ingest paused, fix and rerun" };

const PAUSED = { status: "paused", message: "Scrub failed, ingest paused, fix and rerun" } as const;

/** Runs both mandatory scrubbers in order. Throws if either fails or the payload comes back malformed. */
async function scrubOrThrow(payload: string, presidio: Scrubber, gitleaks: Scrubber): Promise<string> {
  const scrubbed = await scrubWithGitleaks(await scrubWithPresidio(payload, presidio), gitleaks);
  if (typeof scrubbed !== "string") throw new Error("Scrubber returned invalid payload");
  return scrubbed;
}

export async function ingestFailClosed<Incident>(rawPayload: string, options: IngestOptions<Incident>): Promise<IngestResult> {
  if (!(options.localSink instanceof LocalOnlySink)) throw new Error("A concrete local-only sink is required");
  let scrubbed: string;
  try {
    scrubbed = await scrubOrThrow(rawPayload, options.presidio, options.gitleaks);
  } catch {
    await options.localSink.store(rawPayload);
    return PAUSED;
  }
  const incident = await options.modelPass(scrubbed);
  await options.publish(incident);
  return { status: "ingested" };
}

/**
 * Chunk-aware fail-closed ingest. The monolithic scrub runs first, so a clean
 * run costs exactly one scrub pass. When it fails, we do NOT nuke the whole
 * run: instead every chunk is scrubbed on its own, the offenders are
 * quarantined to the local-only sink, and the survivors go on to the model.
 * One false positive in 20k chunks then costs one quarantined chunk, not the
 * entire scan (issue #55).
 *
 * A quarantined chunk is stored RAW to the local sink and never published. If
 * EVERY chunk fails, that is a systemic scrubber fault rather than isolated
 * false positives, so we keep the original fail-closed behavior and pause.
 */
export async function ingestChunksFailClosed<Incident>(
  chunks: readonly unknown[],
  options: IngestOptions<Incident>,
): Promise<IngestResult> {
  if (!(options.localSink instanceof LocalOnlySink)) throw new Error("A concrete local-only sink is required");
  let cleanPayload: string;
  let quarantined = 0;
  try {
    cleanPayload = await scrubOrThrow(JSON.stringify(chunks), options.presidio, options.gitleaks);
  } catch {
    const survivors: unknown[] = [];
    for (const chunk of chunks) {
      const serialized = JSON.stringify(chunk);
      try {
        survivors.push(JSON.parse(await scrubOrThrow(serialized, options.presidio, options.gitleaks)));
      } catch {
        await options.localSink.store(serialized);
        quarantined += 1;
      }
    }
    if (chunks.length > 0 && survivors.length === 0) return PAUSED;
    cleanPayload = JSON.stringify(survivors);
  }
  const incident = await options.modelPass(cleanPayload);
  await options.publish(incident);
  return quarantined > 0 ? { status: "ingested", quarantined } : { status: "ingested" };
}
