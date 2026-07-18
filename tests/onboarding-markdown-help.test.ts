import { expect, test } from "bun:test";
import { lookupMarkdownAnswer } from "../src/onboarding/markdown-help";

test("ASSIST retrieval selects a relevant bounded local paragraph", () => {
  const markdown = [
    "# VibeBloat",
    "Unrelated install notes.",
    "## Privacy",
    "Your transcripts stay local. Presidio and Gitleaks scrub secrets before any model pass. Nothing raw leaves the machine.",
  ].join("\n\n");

  expect(lookupMarkdownAnswer("what happens to transcript secrets?", markdown)).toBe(
    "Your transcripts stay local. Presidio and Gitleaks scrub secrets before any model pass. Nothing raw leaves the machine.",
  );
});

test("ASSIST retrieval does not invent an answer without a matching paragraph", () => {
  expect(lookupMarkdownAnswer("billing model", "Local privacy only.")).toBeUndefined();
});
