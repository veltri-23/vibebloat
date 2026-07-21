import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeRecallConfig } from "../src/ingest/recall-config";
import { GbrainRecallExporter, type ExportedIncident } from "../src/ingest/gbrain-recall";
import {
  scheduleGbrainExport,
  type LiveGitObservation,
  detectLiveGitIncident,
} from "../src/compiler/live-incident";

/**
 * End-to-end gating + export wiring. The bridge is off by default; the
 * exported incident only fires when `[semantic] gbrain_export = true` is
 * set on disk and a configured exporter is reachable. Failures anywhere
 * along the path must be silent so the proposal path stays clean.
 */

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* temp dir was already removed */ }
  }
});

function tempRepo(): string {
  const dir = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-gbrain-export-"));
  temporaryDirectories.push(dir);
  return dir;
}

function liveIncident() {
  const observation: LiveGitObservation = {
    command: "git stash -u",
    exitCode: 0,
    before: { untrackedPaths: ["launch.cmd"] },
    after: { untrackedPaths: [] },
    occurredAt: new Date("2026-07-20T12:00:00.000Z"),
    cwd: process.cwd(),
  };
  const detected = detectLiveGitIncident(observation);
  expect(detected).toBeDefined();
  return detected!;
}

test("writeRecallConfig round-trips gbrain_export = true and preserves unrelated lines", () => {
  const repo = tempRepo();
  const configPath = join(repo, ".vibebloat", "config.toml");
  mkdirSync(join(repo, ".vibebloat"), { recursive: true });
  writeFileSync(configPath, "[unrelated]\nflag = on\n", "utf8");

  writeRecallConfig(configPath, { mode: "lexical", gbrainExport: true });
  const source = readFileSync(configPath, "utf8");
  expect(source).toContain("recall = lexical");
  expect(source).toContain("gbrain_export = true");
  expect(source).toContain("[unrelated]");
  expect(source).toContain("flag = on");
});

test("writeRecallConfig round-trips gbrain_export = false", () => {
  const repo = tempRepo();
  const configPath = join(repo, ".vibebloat", "config.toml");
  writeRecallConfig(configPath, { mode: "lexical", gbrainExport: false });
  const source = readFileSync(configPath, "utf8");
  expect(source).toContain("gbrain_export = false");
});

test("scheduleGbrainExport no-ops when the config file is missing (default off)", () => {
  const repo = tempRepo();
  const configPath = join(repo, ".vibebloat", "config.toml");
  let exported = false;
  const exporter = new GbrainRecallExporter({
    executable: "never",
    executor: async () => {
      exported = true;
      return { exitCode: 0, stdout: "" };
    },
  });

  scheduleGbrainExport(liveIncident(), configPath, { exporter });
  expect(exported).toBe(false);
});

test("scheduleGbrainExport no-ops when gbrain_export is explicitly false", () => {
  const repo = tempRepo();
  const configPath = join(repo, ".vibebloat", "config.toml");
  writeRecallConfig(configPath, { mode: "lexical", gbrainExport: false });

  let exported = false;
  const exporter = new GbrainRecallExporter({
    executable: "never",
    executor: async () => {
      exported = true;
      return { exitCode: 0, stdout: "" };
    },
  });

  scheduleGbrainExport(liveIncident(), configPath, { exporter });
  expect(exported).toBe(false);
});

test("scheduleGbrainExport fires the exporter exactly once when gbrain_export = true and the probe succeeds", async () => {
  const repo = tempRepo();
  const configPath = join(repo, ".vibebloat", "config.toml");
  writeRecallConfig(configPath, { mode: "lexical", gbrainExport: true });

  const seen: ExportedIncident[] = [];
  const exporter = new GbrainRecallExporter({
    executable: "mock-gbrain",
    executor: async (request) => {
      if (request.args[1] === "status") return { exitCode: 0, stdout: "" };
      const payload = request.stdin ? (JSON.parse(request.stdin) as ExportedIncident) : null;
      if (payload) seen.push(payload);
      return { exitCode: 0, stdout: "" };
    },
  });

  scheduleGbrainExport(liveIncident(), configPath, { exporter });
  for (let i = 0; i < 50 && seen.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    command: "git stash",
    condition: expect.stringContaining("untracked"),
    consequence: expect.any(String),
    source: "vibebloat-recall" as const,
  });
});

test("scheduleGbrainExport swallows a broken exporter instead of propagating the failure", async () => {
  const repo = tempRepo();
  const configPath = join(repo, ".vibebloat", "config.toml");
  writeRecallConfig(configPath, { mode: "lexical", gbrainExport: true });

  const exporter = new GbrainRecallExporter({
    executable: "mock-gbrain-broken",
    executor: async () => {
      throw new Error("spawn failed");
    },
  });

  expect(() => scheduleGbrainExport(liveIncident(), configPath, { exporter })).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 25));
});
