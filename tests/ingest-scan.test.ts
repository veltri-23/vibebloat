import { expect, test } from "bun:test";
import { scanHistory } from "../src/ingest/scan";

test("scan scrubs chunks before prefilter and model pass", async () => {
  let modeled = "";
  const result = await scanHistory([
    { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Bearer secret failed" },
  ], {
    presidio: async (payload) => payload,
    gitleaks: async (payload) => payload.replace("secret", "<redacted>"),
    storeLocal: async () => { throw new Error("should not store"); },
    modelPass: async (candidates) => { modeled = candidates[0].content; return [{ incident_id: "one" }]; },
    publish: async () => {},
  });

  expect(result).toEqual({ status: "ingested" });
  expect(modeled).toBe("Bearer <redacted> failed");
});
