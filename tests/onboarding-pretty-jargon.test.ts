import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
setDefaultTimeout(30_000);
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

/**
 * All gate ids the onboarding catalog knows about. SCAN and K are the ones
 * the catalog used to ship with an empty question, which is what made
 * `formatOnboardingPretty` fall through to printing "Gate K." / "Gate SCAN."
 * literally. The test guards the leak.
 */
const ALL_GATE_IDS = [
  "A0", "A1", "F0", "B1", "B1.missing", "B1.ignore", "D1", "D1.1",
  "E1", "E1.1", "E2", "F1", "F1b", "F2", "F2.1", "F3", "F4", "F5", "F6",
  "SR", "SR-no-key",
  "SCAN", "G-empty", "I1", "I-zero", "J0", "J1", "J1-unsure", "J-cluster", "J2", "J3",
  "K", "K-conflict", "K-shim-only", "L1", "M", "N1", "N2", "O1", "O2", "O3", "END",
] as const;

const INTERNAL_GATE_ID_PATTERN = /\bGate [A-Z][A-Z0-9]*(?:\.[A-Za-z0-9]+)?\./;

function runPretty(home: string, gate: string): { stdout: string; stderr: string; exitCode: number } {
  writeFileSync(join(home, "onboarding.json"), JSON.stringify({ gate, answers: {} }));
  const result = Bun.spawnSync(["bun", "src/cli.ts", "init", "--pretty"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      VIBEBLOAT_HOME: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CODEX_HOME: join(home, "codex"),
      HERMES_HOME: join(home, "hermes"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

test("init --pretty never prints a raw gate id (e.g. 'Gate K.') for any catalog gate", () => {
  for (const gate of ALL_GATE_IDS) {
    const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-pretty-"));
    temporaryDirectories.push(home);
    const { stdout, exitCode } = runPretty(home, gate);
    expect({ gate, exitCode }).toEqual({ gate, exitCode: 0 });
    const match = stdout.match(INTERNAL_GATE_ID_PATTERN);
    expect({ gate, match: match?.[0] ?? null }).toEqual({ gate, match: null });
  }
}, 60_000);

test("SCAN renders real consumer copy in pretty mode, not 'Gate SCAN.'", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-pretty-scan-"));
  temporaryDirectories.push(home);
  const { stdout } = runPretty(home, "SCAN");
  expect(stdout).not.toMatch(/Gate SCAN\./);
  // The copy must read as something a human would see, not the gate id.
  // "Scanning" is the verb the user expects; we only require the substring.
  expect(stdout.toLowerCase()).toContain("scanning");
}, 30_000);

test("K renders real consumer copy in pretty mode, not 'Gate K.'", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-pretty-k-"));
  temporaryDirectories.push(home);
  const { stdout } = runPretty(home, "K");
  expect(stdout).not.toMatch(/\bGate K\./);
  // K installs the tripwires. The copy must say something a user recognises.
  expect(stdout.toLowerCase()).toMatch(/install|wir|tripwir/);
}, 30_000);

test("J2 (rule-shape gate) does not leak a TODO-style bullet list to users", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-pretty-j2-"));
  temporaryDirectories.push(home);
  const { stdout } = runPretty(home, "J2");
  // The old copy read like a developer's TODO: "Block or just warn? · ..."
  // The bug brief calls that gate out specifically.
  expect(stdout).not.toMatch(/Block or just warn\?/);
  expect(stdout.toLowerCase()).toContain("tripwir");
}, 30_000);
