import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { appendTelemetry, readTelemetry } from "../src/growth/tracker";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("telemetry stores rule fire metadata without command content", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-telemetry-"));
  tempDirectories.push(directory);
  appendTelemetry(directory, { type: "guard-fired", guardId: "git-stash-u", agent: "codex" });
  expect(readTelemetry(directory)).toEqual([{ type: "guard-fired", guardId: "git-stash-u", agent: "codex" }]);
});
