import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanIncrementalHistory, seedIncrementalCursor } from "../src/ingest/incremental-cursor";
import { createLocalOnlySink } from "../src/scrub/local-sink";
import type { HistoryChunk } from "../src/ingest/types";

const presidioClean = ["bun", "-e", "Bun.stdin.text().then((input) => console.log(JSON.stringify({ payload: JSON.parse(input).payload, findings: [] })))"];
const gitleaksClean = ["bun", "-e", "Bun.stdin.text().then((input) => console.log(JSON.stringify({ payload: JSON.parse(input).payload, findings: [] })))"];

function chunk(sessionId: string, messageIndex: number, content = "failed"): HistoryChunk {
  return { source: "codex", sessionId, messageIndex, chunkIndex: 0, role: "assistant", content };
}

function scanOptions(directory: string, onModel: (chunks: HistoryChunk[]) => Promise<unknown[]> = async () => []) {
  return {
    presidioCommand: presidioClean,
    gitleaksCommand: gitleaksClean,
    localSink: createLocalOnlySink(join(directory, "failed-ingest")),
    modelPass: onModel,
    publish: async () => {},
  };
}

test("incremental cursor stores bounded opaque metadata and scans only new chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-cursor-"));
  try {
    seedIncrementalCursor(directory, [chunk("old-session", 3, "Bearer definitely-not-stored")]);
    const cursor = await readFile(join(directory, "returning-cursor.json"), "utf8");
    expect(cursor).not.toContain("old-session");
    expect(cursor).not.toContain("Bearer definitely-not-stored");

    const modeled: HistoryChunk[][] = [];
    const result = await scanIncrementalHistory({
      directory,
      loadHistory: async () => [chunk("old-session", 3), chunk("old-session", 4), chunk("new-session", 0, "broken")],
      scan: scanOptions(directory, async (chunks) => { modeled.push(chunks); return []; }),
    });

    expect(result).toEqual({ status: "ingested", chunksScanned: 2 });
    expect(modeled).toHaveLength(1);
    expect(modeled[0].map(({ sessionId, messageIndex }) => ({ sessionId, messageIndex })).sort((left, right) => left.sessionId.localeCompare(right.sessionId))).toEqual([
      { sessionId: "new-session", messageIndex: 0 },
      { sessionId: "old-session", messageIndex: 4 },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or malformed cursor fails before reading returning history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-cursor-"));
  let reads = 0;
  try {
    await expect(scanIncrementalHistory({
      directory,
      loadHistory: async () => { reads += 1; return [chunk("new", 0)]; },
      scan: scanOptions(directory),
    })).rejects.toThrow("Returning scan cursor is missing or invalid");
    await writeFile(join(directory, "returning-cursor.json"), '{"schemaVersion":1,"sources":[{"source":"codex","sessions":[{"sessionDigest":"raw-secret","messageIndex":0,"chunkIndex":0}]}]}\n');
    await expect(scanIncrementalHistory({
      directory,
      loadHistory: async () => { reads += 1; return [chunk("new", 0)]; },
      scan: scanOptions(directory),
    })).rejects.toThrow("Returning scan cursor is missing or invalid");
    expect(reads).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a paused scrub does not advance the durable cursor", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-cursor-"));
  try {
    seedIncrementalCursor(directory, [chunk("old", 0)]);
    const before = await readFile(join(directory, "returning-cursor.json"), "utf8");
    const paused = await scanIncrementalHistory({
      directory,
      loadHistory: async () => [chunk("old", 0), chunk("new", 0, "Authorization: Bearer raw-token")],
      scan: scanOptions(directory),
    });
    expect(paused).toEqual({ status: "paused", chunksScanned: 1 });
    expect(await readFile(join(directory, "returning-cursor.json"), "utf8")).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cursor session state is bounded per source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-cursor-"));
  try {
    seedIncrementalCursor(directory, [chunk("one", 0), chunk("two", 0), chunk("three", 0)], 2);
    const state = JSON.parse(await readFile(join(directory, "returning-cursor.json"), "utf8")) as { sources: Array<{ sessions: unknown[] }> };
    expect(state.sources[0].sessions).toHaveLength(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
