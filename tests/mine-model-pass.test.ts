import { expect, test } from "bun:test";
import { runModelPass } from "../src/mine/model-pass";
import { markScrubbedCandidates } from "../src/scrub/scrubbed-candidates";

test("model pass is mandatory and receives only scrubbed candidates", async () => {
  let received = "";
  const result = await runModelPass(markScrubbedCandidates([{ source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Bearer <redacted> failed" }]), async (candidates) => {
    received = candidates[0].content;
    return [{ incident_id: "guard-1" }];
  });

  expect(received).toBe("Bearer <redacted> failed");
  expect(result).toEqual([{ incident_id: "guard-1" }]);
});

test("forged scrubbed-candidates input never reaches the model", async () => {
  let modeled = 0;
  const forged = {
    candidates: [{ source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token" }],
  } as never;

  await expect(runModelPass(forged, async () => { modeled += 1; return []; })).rejects.toThrow("Model pass requires scrubbed candidates");
  expect(modeled).toBe(0);
});
