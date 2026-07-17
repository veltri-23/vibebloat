import { describe, expect, test } from "bun:test";
import { ingestFailClosed } from "../../src/scrub/fail-closed";

const rawHermesHistory = '{"Authorization":"Bearer secret-token"}';

function setup(failingScrubber: "presidio" | "gitleaks") {
  let modeled = 0;
  let published = 0;
  const local: string[] = [];
  return {
    options: {
      presidio: async (payload: string) => {
        if (failingScrubber === "presidio") throw new Error("presidio offline");
        return payload.replace("secret-token", "<redacted>");
      },
      gitleaks: async (payload: string) => {
        if (failingScrubber === "gitleaks") throw new Error("gitleaks unavailable");
        return payload;
      },
      storeLocal: async (payload: string) => { local.push(payload); },
      modelPass: async () => { modeled += 1; return { incident: "never" }; },
      publish: async () => { published += 1; },
    },
    counts: () => ({ modeled, published, local }),
  };
}

describe("CRITICAL: scrub failure closes ingestion", () => {
  test.each(["presidio", "gitleaks"] as const)("halts before model or publish when %s errors", async (failingScrubber) => {
    const { options, counts } = setup(failingScrubber);
    const result = await ingestFailClosed(rawHermesHistory, options);

    expect(result).toEqual({ status: "paused", message: "Scrub failed, ingest paused, fix and rerun" });
    expect(counts()).toEqual({ modeled: 0, published: 0, local: [rawHermesHistory] });
  });

  test("runs both scrubbers before model and only publishes redacted output", async () => {
    const calls: string[] = [];
    const result = await ingestFailClosed(rawHermesHistory, {
      presidio: async (payload) => { calls.push("presidio"); return payload.replace("secret-token", "<redacted>"); },
      gitleaks: async (payload) => { calls.push("gitleaks"); return payload; },
      storeLocal: async () => { throw new Error("should not store"); },
      modelPass: async (payload) => { calls.push(payload); return { incident: "safe" }; },
      publish: async (incident) => { calls.push(incident.incident); },
    });

    expect(result).toEqual({ status: "ingested" });
    expect(calls).toEqual(["presidio", "gitleaks", '{"Authorization":"Bearer <redacted>"}', "safe"]);
  });
});
