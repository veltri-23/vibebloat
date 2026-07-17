import { expect, test } from "bun:test";
import { acceptAnonymousIngest } from "../src/growth/ingest-endpoint";

test("ingest endpoint accepts opt-in anonymous payloads only", () => {
  expect(acceptAnonymousIngest(false, { class: "A", pattern: "git stash -u" })).toEqual({ accepted: false });
  expect(acceptAnonymousIngest(true, { class: "A", pattern: "git stash -u" })).toEqual({ accepted: true });
  expect(() => acceptAnonymousIngest(true, { class: "A", pattern: "Bearer secret" })).toThrow("Scrub required");
});
