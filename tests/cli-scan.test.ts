import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const presidioRedact = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload: payload.replace('secret-token', '<redacted>'), findings: [] })); })",
];
const passThrough = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { payload } = JSON.parse(input); console.log(JSON.stringify({ payload, findings: [] })); })",
];
const model = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { candidates } = JSON.parse(input); if (!candidates[0].content.includes('<redacted>')) process.exit(1); console.log(JSON.stringify([{ incident_id: 'low', class: 'C', chokepoint: 'file', path: '.env', condition: 'broken config', evidence_refs: ['one:0'], severity: 1, frequency: 3, recency: '2026-07-16' }, { incident_id: 'high', class: 'A', chokepoint: 'shell', command: 'git stash -u', condition: 'destructive stash', evidence_refs: ['one:1'], severity: 5, frequency: 1, recency: '2026-07-15' }])); })",
];

function scan(historyPath: string, home: string, overrides: Record<string, string | undefined> = {}) {
  return Bun.spawnSync(["bun", "src/cli.ts", "scan", historyPath], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      VIBEBLOAT_HOME: home,
      VIBEBLOAT_PRESIDIO_COMMAND: JSON.stringify(presidioRedact),
      VIBEBLOAT_GITLEAKS_COMMAND: JSON.stringify(passThrough),
      VIBEBLOAT_MODEL_COMMAND: JSON.stringify(model),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("scan emits actual scrubbed ranked incidents from the model pass", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const history = join(directory, "history.json");
  writeFileSync(history, JSON.stringify([
    { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token failed" },
    { source: "hermes", sessionId: "one", messageIndex: 1, chunkIndex: 0, role: "user", content: "normal message" },
  ]));

  const result = scan(history, directory);

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    status: "ingested",
    chunks_scanned: 2,
    candidates_scanned: 1,
    incidents_found: 2,
    ranked_incidents: [{ incident_id: "high" }, { incident_id: "low" }],
  });
  expect(result.stdout.toString()).not.toContain("secret-token");
});

test("scan pauses before model output when scrubbers leave a raw Bearer token", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const history = join(directory, "history.json");
  writeFileSync(history, JSON.stringify([
    { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token failed" },
  ]));

  const result = scan(history, directory, { VIBEBLOAT_PRESIDIO_COMMAND: JSON.stringify(passThrough) });

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("WHAT failed: scan paused.\nWHY: Scrub failed, ingest paused, fix and rerun\nFIX: repair scrubber commands and rerun vibebloat scan <history.json>\n");
  const [stored] = require("node:fs").readdirSync(join(directory, "failed-ingest"));
  expect(readFileSync(join(directory, "failed-ingest", stored), "utf8")).toContain("Bearer secret-token");
});
