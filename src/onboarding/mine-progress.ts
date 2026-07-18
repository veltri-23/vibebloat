import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";
import { canonicalGateChoice, getGate, type GateChoice } from "./gates";

const checkpointFilename = "mine-progress.json";
const progressWidth = 20;

export type MineRunMode = "foreground" | "background";
export type MineProgressStatus = "running" | "cancelled" | "completed";

export interface MineProgress {
  version: 1;
  stage: "mine";
  totalCandidates: number;
  completedCandidates: number;
  mode: MineRunMode;
  status: MineProgressStatus;
}

export interface MineProgressUpdate {
  progress: MineProgress;
  display: string;
}

export interface MineProgressOptions {
  directory: string;
  totalCandidates: number;
  f3Choice?: GateChoice;
  signal?: AbortSignal;
  onProgress?(update: MineProgressUpdate): void;
}

function validCandidateCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isMineProgress(value: unknown): value is MineProgress {
  if (typeof value !== "object" || value === null) return false;
  const progress = value as Partial<MineProgress>;
  return progress.version === 1
    && progress.stage === "mine"
    && validCandidateCount(progress.totalCandidates)
    && typeof progress.completedCandidates === "number"
    && Number.isSafeInteger(progress.completedCandidates)
    && progress.completedCandidates >= 0
    && progress.completedCandidates <= progress.totalCandidates
    && (progress.mode === "foreground" || progress.mode === "background")
    && (progress.status === "running" || progress.status === "cancelled" || progress.status === "completed");
}

function copyProgress(progress: MineProgress): MineProgress {
  return { ...progress };
}

export function mineProgressCheckpointPath(directory: string): string {
  return join(directory, checkpointFilename);
}

export function readMineProgress(directory: string): MineProgress | undefined {
  const path = mineProgressCheckpointPath(directory);
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isMineProgress(parsed)) throw new Error("Mine progress checkpoint is invalid; it was not resumed.");
  return copyProgress(parsed);
}

export function mineModeForF3Choice(choice: GateChoice | undefined): MineRunMode {
  if (choice === undefined) return "foreground";
  return canonicalGateChoice("F3", choice) === getGate("F3").options[1] ? "background" : "foreground";
}

export function formatMineProgress(progress: MineProgress): string {
  const percentage = Math.floor((progress.completedCandidates / progress.totalCandidates) * 100);
  const filled = Math.min(progressWidth, Math.floor((percentage / 100) * progressWidth));
  const bar = `${"#".repeat(filled)}${"-".repeat(progressWidth - filled)}`;
  const label = progress.status === "completed"
    ? "Scan complete"
    : progress.status === "cancelled"
      ? "Scan paused"
      : progress.mode === "background"
        ? "Scanning in background"
        : "Scanning";
  return `${label} [${bar}] ${progress.completedCandidates}/${progress.totalCandidates} (${percentage}%)`;
}

export class MineProgressReporter {
  private progress: MineProgress;

  constructor(private readonly options: MineProgressOptions) {
    if (!validCandidateCount(options.totalCandidates)) throw new Error("Mine progress requires at least one candidate.");
    const existing = readMineProgress(options.directory);
    if (existing && existing.totalCandidates !== options.totalCandidates) {
      throw new Error("Mine progress candidate count changed; refusing to restart an incomplete scan.");
    }
    this.progress = existing
      ? { ...existing, status: existing.status === "cancelled" ? "running" : existing.status }
      : {
        version: 1,
        stage: "mine",
        totalCandidates: options.totalCandidates,
        completedCandidates: 0,
        mode: mineModeForF3Choice(options.f3Choice),
        status: "running",
      };
    this.persist();
    this.emit();
  }

  current(): MineProgressUpdate {
    return { progress: copyProgress(this.progress), display: formatMineProgress(this.progress) };
  }

  report(completedCandidates: number): MineProgressUpdate {
    if (this.options.signal?.aborted) return this.cancel();
    if (this.progress.status !== "running") throw new Error("Mine progress is not running; resume or finish the existing scan first.");
    if (!Number.isSafeInteger(completedCandidates) || completedCandidates < this.progress.completedCandidates || completedCandidates > this.progress.totalCandidates) {
      throw new Error("Mine progress must move forward without exceeding its candidate total.");
    }
    this.progress = { ...this.progress, completedCandidates };
    this.persist();
    return this.emit();
  }

  cancel(): MineProgressUpdate {
    if (this.progress.status === "completed") return this.current();
    this.progress = { ...this.progress, status: "cancelled" };
    this.persist();
    return this.emit();
  }

  complete(): MineProgressUpdate {
    if (this.progress.status !== "running") throw new Error("Mine progress is not running; resume or finish the existing scan first.");
    if (this.progress.completedCandidates !== this.progress.totalCandidates) {
      throw new Error("Mine progress cannot complete before every candidate is processed.");
    }
    this.progress = { ...this.progress, status: "completed" };
    this.persist();
    return this.emit();
  }

  private persist(): void {
    replaceGuardAtomically(mineProgressCheckpointPath(this.options.directory), `${JSON.stringify(this.progress)}\n`);
  }

  private emit(): MineProgressUpdate {
    const update = this.current();
    this.options.onProgress?.(update);
    return update;
  }
}

export function clearCompletedMineProgress(directory: string): void {
  const progress = readMineProgress(directory);
  if (!progress) return;
  if (progress.status !== "completed") throw new Error("Mine progress is incomplete; refusing to discard its resume checkpoint.");
  rmSync(mineProgressCheckpointPath(directory), { force: true });
}
