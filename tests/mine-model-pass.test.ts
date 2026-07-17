import { expect, test } from "bun:test";
import { runModelPass } from "../src/mine/model-pass";

test("model pass is mandatory and receives only scrubbed candidates", async () => {
  let received = "";
  const result = await runModelPass([{ source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Bearer <redacted> failed" }], async (candidates) => {
    received = candidates[0].content;
    return [{ incident_id: "guard-1" }];
  });

  expect(received).toBe("Bearer <redacted> failed");
  expect(result).toEqual([{ incident_id: "guard-1" }]);
});
