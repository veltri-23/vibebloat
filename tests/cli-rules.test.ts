import { expect, test } from "bun:test";
import { summarizeRules } from "../src/cli/rules";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";

test("rule summaries expose management metadata without incident content", () => {
  const summaries = summarizeRules([mcpConfigWrongFileGuard, gitStashUntrackedGuard]);

  expect(summaries.map(({ id }) => id)).toEqual(["git-stash-u", "mcp-config-wrong-file"]);
  expect(summaries[0]).toEqual({
    action: "block",
    binds: [],
    class: "A",
    confidence: null,
    enabled: true,
    id: "git-stash-u",
    tier: null,
  });
  const output = JSON.stringify(summaries);
  expect(output).not.toContain("incident");
  expect(output).not.toContain("message");
  expect(output).not.toContain("path");
});
