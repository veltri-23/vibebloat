import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanHistory } from "../src/ingest/scan";
import { createLocalOnlySink } from "../src/scrub/local-sink";

const presidioRedact = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload: payload.replace('secret', '<redacted>'), findings: [] })); })",
];

const gitleaksClean = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload, findings: [] })); })",
];

test("scan executes mandatory command scrubbers before prefilter and model pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-scrub-"));
  let modeled = "";
  try {
    const result = await scanHistory([
      { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Bearer secret failed" },
    ], {
      presidioCommand: presidioRedact,
      gitleaksCommand: gitleaksClean,
      localSink: createLocalOnlySink(directory),
      modelPass: async (candidates) => { modeled = candidates[0].content; return [{ incident_id: "one" }]; },
      publish: async () => {},
    });

    expect(result).toEqual({ status: "ingested" });
    expect(modeled).toBe("Bearer <redacted> failed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw Bearer output pauses before model or publish and persists only to local sink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-scrub-"));
  let modeled = 0;
  let published = 0;
  try {
    const result = await scanHistory([
      { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token" },
    ], {
      presidioCommand: gitleaksClean,
      gitleaksCommand: gitleaksClean,
      localSink: createLocalOnlySink(directory),
      modelPass: async () => { modeled += 1; return []; },
      publish: async () => { published += 1; },
    });

    expect(result).toEqual({ status: "paused", message: "Scrub failed, ingest paused, fix and rerun" });
    expect({ modeled, published }).toEqual({ modeled: 0, published: 0 });
    const [stored] = await readdir(directory);
    expect(await readFile(join(directory, stored), "utf8")).toContain("Bearer secret-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
