import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MineProgressReporter, clearCompletedMineProgress, mineModeForF3Choice, mineProgressCheckpointPath, readMineProgress } from "../src/onboarding/mine-progress";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-mine-progress-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("mine streams a visible progress bar and resumes from its atomic checkpoint", () => {
  const directory = temporaryDirectory();
  const updates: string[] = [];
  const first = new MineProgressReporter({ directory, totalCandidates: 8, onProgress: ({ display }) => updates.push(display) });

  expect(first.report(3)).toEqual({
    progress: { version: 1, stage: "mine", totalCandidates: 8, completedCandidates: 3, mode: "foreground", status: "running" },
    display: "Scanning [#######-------------] 3/8 (37%)",
  });
  expect(readMineProgress(directory)).toMatchObject({ completedCandidates: 3, status: "running" });

  const resumed = new MineProgressReporter({ directory, totalCandidates: 8, onProgress: ({ display }) => updates.push(display) });
  expect(resumed.current().display).toBe("Scanning [#######-------------] 3/8 (37%)");
  expect(updates).toHaveLength(3);
});

test("a cancellation signal pauses mine work without losing completed progress", () => {
  const directory = temporaryDirectory();
  const signal = new AbortController();
  const progress = new MineProgressReporter({ directory, totalCandidates: 4, signal: signal.signal });

  progress.report(2);
  signal.abort();
  expect(progress.report(3)).toMatchObject({ progress: { completedCandidates: 2, status: "cancelled" }, display: expect.stringContaining("Scan paused") });
  expect(readMineProgress(directory)).toMatchObject({ completedCandidates: 2, status: "cancelled" });

  const resumed = new MineProgressReporter({ directory, totalCandidates: 4 });
  expect(resumed.current().progress).toMatchObject({ completedCandidates: 2, status: "running" });
});

test("background mine work needs the exact human F3 choice", () => {
  expect(mineModeForF3Choice(undefined)).toBe("foreground");
  expect(mineModeForF3Choice("I'll wait, show me progress (recommended)")).toBe("foreground");
  expect(mineModeForF3Choice("Set up the important rules now, finish the deep part in the background")).toBe("background");

  const directory = temporaryDirectory();
  const progress = new MineProgressReporter({
    directory,
    totalCandidates: 2,
    f3Choice: "Set up the important rules now, finish the deep part in the background",
  });
  expect(progress.current().display).toBe("Scanning in background [--------------------] 0/2 (0%)");
});

test("only completed mine work can discard its checkpoint", () => {
  const directory = temporaryDirectory();
  const progress = new MineProgressReporter({ directory, totalCandidates: 2 });

  expect(() => clearCompletedMineProgress(directory)).toThrow("incomplete");
  progress.report(2);
  progress.complete();
  clearCompletedMineProgress(directory);
  expect(existsSync(mineProgressCheckpointPath(directory))).toBeFalse();
});
