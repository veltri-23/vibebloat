import { expect, test } from "bun:test";
import { filterGuardRecords } from "../site/library-filter.js";

const records = [
  { id: "git-stash-u", description: "Blocks broad stashes that remove untracked work", pattern: "git stash -u", class: "A", confidence: "high", agents: ["claude-code", "codex"] },
  { id: "mcp-config-wrong-file", description: "Warns when MCP configuration uses the wrong file", pattern: ".mcp.json", class: "B", confidence: "high", agents: ["claude-code"] },
  { id: "env-review", description: "Reviews environment changes", pattern: ".env", class: "B", confidence: "low", agents: ["hermes", "openclaw"] },
];

test("library search covers descriptions and command patterns", () => {
  expect(filterGuardRecords(records, { query: "untracked stash" }).map((record) => record.id)).toEqual(["git-stash-u"]);
  expect(filterGuardRecords(records, { query: ".mcp.json" }).map((record) => record.id)).toEqual(["mcp-config-wrong-file"]);
});

test("library filters use AND across groups and OR within groups", () => {
  expect(filterGuardRecords(records, {
    classes: ["A", "B"],
    confidences: ["high"],
    agents: ["codex", "hermes"],
  }).map((record) => record.id)).toEqual(["git-stash-u"]);
});

test("library controls expose keyboard and live-region accessibility", async () => {
  const html = await Bun.file(new URL("../site/index.html", import.meta.url)).text();
  expect(html).toContain('class="skip-link" href="#main-content"');
  expect(html).toContain('<main id="main-content">');
  expect(html).toContain('label for="library-search"');
  expect(html).toContain('role="status" aria-live="polite"');
  expect(html).toContain('type="checkbox" name="agent"');
});
