import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendFiring, readAndPruneFirings, type FiringMetadata } from "../src/audit/firings";

const temporaryDirectories: string[] = [];
const metadata: FiringMetadata = {
  guardId: "git-stash-u",
  class: "A",
  chokepoint: "shell",
  actionType: "block",
  blocked: true,
  agent: "codex",
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function home(): string {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-audit-"));
  temporaryDirectories.push(directory);
  return directory;
}

test("a firing appends one closed metadata-only event atomically", () => {
  const directory = home();
  const result = appendFiring(directory, true, metadata, new Date("2026-07-18T12:34:56.789Z"));
  expect(result.status).toBe("appended");
  expect(result.warnings).toEqual([]);
  const firings = join(directory, "audit", "firings");
  const files = readdirSync(firings);
  expect(files).toEqual([`${result.status === "appended" ? result.event.eventId : ""}.json`]);
  const event = JSON.parse(readFileSync(join(firings, files[0]!), "utf8"));
  expect(event).toEqual(result.status === "appended" ? result.event : undefined);
  expect(Object.keys(event).sort()).toEqual(["actionType", "agent", "blocked", "chokepoint", "class", "eventId", "firedAt", "guardId", "schemaVersion"]);
  if (process.platform !== "win32") {
    expect(statSync(firings).mode & 0o777).toBe(0o700);
    expect(statSync(join(firings, files[0]!)).mode & 0o777).toBe(0o600);
  }
});

test("a non-firing writes no audit directory", () => {
  const directory = home();
  expect(appendFiring(directory, false, { command: "Bearer secret" })).toEqual({ status: "skipped", warnings: [] });
  expect(readdirSync(directory)).toEqual([]);
});

test("forbidden command, path, payload, message, incident, and secret fields never write", () => {
  const directory = home();
  const forbidden = {
    ...metadata,
    command: "git stash -u Bearer secret",
    path: "C:\\private\\.env",
    payload: { token: "secret" },
    message: "private guard message",
    incident: "private incident",
    secret: "credential",
  };
  expect(() => appendFiring(directory, true, forbidden)).toThrow("forbidden field");
  expect(readdirSync(directory)).toEqual([]);
});

test("retention prunes the exact thirty-day boundary and keeps newer events", () => {
  const directory = home();
  appendFiring(directory, true, { ...metadata, guardId: "boundary" }, new Date("2026-06-18T12:00:00.000Z"));
  appendFiring(directory, true, { ...metadata, guardId: "newer" }, new Date("2026-06-18T12:00:00.001Z"));

  const result = readAndPruneFirings(directory, new Date("2026-07-18T12:00:00.000Z"));
  expect(result.pruned).toBe(1);
  expect(result.events.map((event) => event.guardId)).toEqual(["newer"]);
});

test("malformed and future events are quarantined and excluded", () => {
  const directory = home();
  const firings = join(directory, "audit", "firings");
  mkdirSync(firings, { recursive: true });
  writeFileSync(join(firings, "malformed.json"), "{not-json");
  appendFiring(directory, true, metadata, new Date("2026-07-19T00:00:00.000Z"));

  const result = readAndPruneFirings(directory, new Date("2026-07-18T00:00:00.000Z"));
  expect(result.events).toEqual([]);
  expect(result.quarantined).toBe(1);
  expect(readdirSync(join(directory, "audit", "quarantine", "firings"))).toHaveLength(2);
});

test("prune failure returns a warning without losing the appended event", () => {
  const directory = home();
  const firings = join(directory, "audit", "firings");
  mkdirSync(firings, { recursive: true });
  writeFileSync(join(firings, "malformed.json"), "{not-json");
  writeFileSync(join(directory, "audit", "quarantine"), "blocks quarantine directory");

  const result = appendFiring(directory, true, metadata, new Date("2026-07-18T00:00:00.000Z"));
  expect(result.status).toBe("appended");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toMatchObject({ what: "Audit retention cleanup failed.", fix: "vibebloat doctor" });
  if (result.status === "appended") expect(readFileSync(join(firings, `${result.event.eventId}.json`), "utf8")).toContain(result.event.eventId);
});
