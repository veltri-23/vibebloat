import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readCheckpoint, readValidatedCheckpoint, writeCheckpoint } from "../src/ingest/resume";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("scan checkpoints survive resume without rereading prior stages", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-resume-"));
  tempDirectories.push(directory);
  writeCheckpoint(directory, "ingested", { sessions: 3 });
  expect(readCheckpoint(directory, "ingested")).toEqual({ sessions: 3 });
  expect(readCheckpoint(directory, "incidents")).toBeUndefined();
});

test("validated checkpoint reader classifies old or malformed markers as legacy", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-resume-"));
  tempDirectories.push(directory);
  writeCheckpoint(directory, "ingested", { sessions: 3 });

  expect(readValidatedCheckpoint(directory, "ingested", (value): value is { schemaVersion: 1 } =>
    Boolean(value && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 1))).toEqual({ status: "legacy" });
});

test("checkpoint stage cannot escape its directory", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-resume-"));
  tempDirectories.push(directory);
  expect(() => writeCheckpoint(directory, "../escape", {})).toThrow("simple identifier");
});
