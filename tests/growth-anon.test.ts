import { expect, test } from "bun:test";
import { anonymizeIncident } from "../src/growth/anon-stream";

test("anonymous stream rejects raw secrets and removes local evidence", () => {
  expect(() => anonymizeIncident({ class: "A", pattern: "git stash -u", evidence: "Bearer secret" })).toThrow("Scrub required");
  expect(anonymizeIncident({ class: "A", pattern: "git stash -u", evidence: "<redacted>" })).toEqual({ class: "A", pattern: "git stash -u" });
});
