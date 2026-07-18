import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const presidioRedact = ["presidio-wrapper", "--json"];
const passThrough = ["gitleaks-wrapper", "--json"];
const model = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { candidates } = JSON.parse(input); if (!candidates[0].content.includes('<redacted>')) process.exit(1); console.log(JSON.stringify([{ incident_id: 'low', class: 'C', chokepoint: 'file', path: '.env', condition: 'broken config', evidence_refs: ['one:0'], severity: 1, frequency: 3, recency: '2026-07-16' }, { incident_id: 'high', class: 'A', chokepoint: 'shell', command: 'git stash -u', condition: 'destructive stash', evidence_refs: ['one:1'], severity: 5, frequency: 1, recency: '2026-07-15' }])); })",
];

function installLocalScrubberWrappers(directory: string, presidioPassesThrough = false) {
  const fixture = join(import.meta.dir, "fixtures", "local-scrubber.ts");
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (const [name, kind] of [["presidio-wrapper", presidioPassesThrough ? "pass-through" : "presidio"], ["gitleaks-wrapper", "gitleaks"]] as const) {
    writeFileSync(join(directory, `${name}.cmd`), `@echo off\r\n${quote(process.execPath)} ${quote(fixture)} ${kind}\r\n`);
  }
}

function scan(historyPath: string, home: string, overrides: Record<string, string | undefined> = {}, presidioPassesThrough = false) {
  const wrappers = join(home, "scrubber-wrappers");
  require("node:fs").mkdirSync(wrappers);
  installLocalScrubberWrappers(wrappers, presidioPassesThrough);
  return Bun.spawnSync(["bun", "src/cli.ts", "scan", historyPath], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      VIBEBLOAT_HOME: home,
      VIBEBLOAT_PRESIDIO_COMMAND: JSON.stringify(presidioRedact),
      VIBEBLOAT_GITLEAKS_COMMAND: JSON.stringify(passThrough),
      VIBEBLOAT_MODEL_COMMAND: JSON.stringify(model),
      PATH: `${wrappers};${process.env.PATH ?? ""}`,
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
}, 15_000);

test("scan rejects an arbitrary scrubber command before reading raw history", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const history = join(directory, "history.json");
  const marker = join(directory, "raw-payload-was-routed");
  writeFileSync(history, JSON.stringify([
    { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token failed" },
  ]));

  const result = scan(history, directory, {
    VIBEBLOAT_PRESIDIO_COMMAND: JSON.stringify(["bun", "-e", `Bun.write(${JSON.stringify(marker)}, await Bun.stdin.text())`]),
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("VIBEBLOAT_PRESIDIO_COMMAND must use the installed presidio-wrapper command");
  expect(require("node:fs").existsSync(marker)).toBe(false);
}, 15_000);

test("scan pauses before model output when scrubbers leave a raw Bearer token", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const history = join(directory, "history.json");
  writeFileSync(history, JSON.stringify([
    { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token failed" },
  ]));

  const result = scan(history, directory, {}, true);

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("WHAT failed: scan paused.\nWHY: Scrub failed, ingest paused, fix and rerun\nFIX: repair scrubber commands and rerun vibebloat scan <history.json>\n");
  const [stored] = require("node:fs").readdirSync(join(directory, "failed-ingest"));
  expect(readFileSync(join(directory, "failed-ingest", stored), "utf8")).toContain("Bearer secret-token");
}, 15_000);
