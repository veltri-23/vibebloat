import { expect, test } from "bun:test";
import { communityGuards, communityGuardsForAgent, libraryEntries, type LibraryEntry } from "../src/library/community-guards";
import { validateCommunityGuard } from "../src/library/validate";

const entries = libraryEntries();

test("ships exactly 50 community guards with unique ids", () => {
  expect(entries.length).toBe(50);
  const ids = new Set(entries.map((entry) => entry.guard.id));
  expect(ids.size).toBe(50);
  expect(communityGuards().length).toBe(50);
});

test("every guard proves its matcher: positive fires, negative does not", () => {
  const failures: string[] = [];
  for (const entry of entries) {
    const { errors } = validateCommunityGuard(entry.guard, entry.vector);
    if (errors.length) failures.push(`${entry.guard.id}: ${errors.join("; ")}`);
  }
  expect(failures).toEqual([]);
});

test("bucket distribution is 20 codex / 10 claude / 10 hermes / 10 general", () => {
  const count = (bucket: LibraryEntry["bucket"]) => entries.filter((entry) => entry.bucket === bucket).length;
  expect(count("codex")).toBe(20);
  expect(count("claude")).toBe(10);
  expect(count("hermes")).toBe(10);
  expect(count("general")).toBe(10);
});

test("every guard binds to the agent its bucket targets", () => {
  const bucketAgent = { codex: "codex", claude: "claude-code", hermes: "hermes" } as const;
  for (const entry of entries) {
    if (entry.bucket === "general") continue;
    expect(entry.guard.binds).toContain(bucketAgent[entry.bucket]);
  }
});

test("agent filter returns each agent's applicable guards", () => {
  // general guards bind all four, so every agent sees at least the 10 general ones.
  expect(communityGuardsForAgent("codex").length).toBeGreaterThanOrEqual(30);
  expect(communityGuardsForAgent("claude-code").length).toBeGreaterThanOrEqual(20);
  expect(communityGuardsForAgent("hermes").length).toBeGreaterThanOrEqual(20);
});
