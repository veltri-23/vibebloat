import { expect, test } from "bun:test";
import { parseHermesHistory } from "../src/ingest/hermes-history";

test("Hermes adapter extracts request messages for immediate scrub", () => {
  const chunks = parseHermesHistory(JSON.stringify({
    session_id: "hermes-1",
    request: { body: { messages: [{ role: "user", content: "Authorization: Bearer secret" }] } },
  }), "fallback.json");

  expect(chunks).toEqual([
    { source: "hermes", sessionId: "hermes-1", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret" },
  ]);
});
