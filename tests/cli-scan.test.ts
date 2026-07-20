import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const model = [
  "bun",
  "-e",
  "Bun.stdin.text().then((input) => { const { candidates } = JSON.parse(input); if (!candidates[0].content.includes('<redacted>')) process.exit(1); console.log(JSON.stringify([{ incident_id: 'low', class: 'C', chokepoint: 'file', path: '.env', condition: 'broken config', evidence_refs: ['one:0'], severity: 1, frequency: 3, recency: '2026-07-16' }, { incident_id: 'high', class: 'A', chokepoint: 'shell', command: 'git stash -u', condition: 'destructive stash', evidence_refs: ['one:1'], severity: 5, frequency: 1, recency: '2026-07-15' }])); })",
];

function scan(historyPath: string, home: string, overrides: Record<string, string | undefined> = {}) {
  const wrappers = join(home, "scrubber-wrappers");
  require("node:fs").mkdirSync(wrappers, { recursive: true });
  return Bun.spawnSync(["bun", "src/cli.ts", "scan", historyPath], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      VIBEBLOAT_HOME: home,
      VIBEBLOAT_MODEL_COMMAND: JSON.stringify(model),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("scan ignores PATH scrubbers and scrubs in-process instead", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const history = join(directory, "history.json");
  const marker = join(directory, "raw-payload-was-routed");
  const wrappers = join(directory, "scrubber-wrappers");
  require("node:fs").mkdirSync(wrappers);
  writeFileSync(join(wrappers, "presidio-wrapper.cmd"), `@echo off\r\nmore > "${marker}"\r\n`);
  writeFileSync(history, JSON.stringify([{ source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token failed" }]));

  const result = scan(history, directory, { PATH: `${wrappers};${process.env.PATH ?? ""}` });

  // A PATH-planted scrubber must never receive raw history, and its absence
  // must not dead-end the scan: the built-in scrubber runs in-process.
  expect(existsSync(marker)).toBe(false);
  expect(result.exitCode).toBe(0);
  // The model stub exits non-zero unless it received redacted content.
  expect(result.stderr.toString()).not.toContain("scrubber assets are unavailable");
}, 15_000);

test("scan ignores former scrubber environment overrides before reading raw history", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const history = join(directory, "history.json");
  const marker = join(directory, "raw-payload-was-routed");
  writeFileSync(history, JSON.stringify([
    { source: "hermes", sessionId: "one", messageIndex: 0, chunkIndex: 0, role: "user", content: "Authorization: Bearer secret-token failed" },
  ]));

  const result = scan(history, directory, {
    VIBEBLOAT_PRESIDIO_COMMAND: JSON.stringify(["bun", "-e", `Bun.write(${JSON.stringify(marker)}, await Bun.stdin.text())`]),
    VIBEBLOAT_GITLEAKS_COMMAND: JSON.stringify(["bun", "-e", `Bun.write(${JSON.stringify(marker)}, await Bun.stdin.text())`]),
  });

  // Former override vars are inert: they must not route raw history anywhere,
  // and must not block the scan either.
  expect(existsSync(marker)).toBe(false);
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain("scrubber assets are unavailable");
}, 15_000);

test("scan rejects a directory history path before reading anything", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-scan-"));
  temporaryDirectories.push(directory);
  const result = scan(directory, directory);

  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("scan blocked before history read");
}, 15_000);
