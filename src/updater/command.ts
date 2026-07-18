import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  coordinateUpdate,
  formatUpdateError,
  formatUpdateSuccess,
  UpdateCoordinatorError,
  type UpdateCoordinatorResult,
} from "./coordinator";
import type { WindowsSwapStageOptions } from "./windows-swap";

type CommandRunner = (command: readonly string[]) => number;

export type UpdateCommandFailureCode = "arguments" | "trust-assets" | "standalone";

export class UpdateCommandError extends Error {
  constructor(readonly code: UpdateCommandFailureCode) {
    super(code === "arguments"
      ? "Expected no arguments or --apply."
      : code === "trust-assets"
        ? "Controlled release metadata and pinned public key are required."
        : "Applying an update requires the signed standalone executable.");
    this.name = "UpdateCommandError";
  }
}

export interface ControlledUpdateCommandOptions {
  apply: boolean;
  communityGuardDirectory: string;
  currentVersion: string;
  doctor: () => boolean;
  packageRoot: string;
  run: CommandRunner;
  selfCommand: readonly string[];
  platform?: NodeJS.Platform;
  scheduleWindowsSwap?: (options: WindowsSwapStageOptions) => unknown;
}

export function parseUpdateArguments(arguments_: readonly string[]): boolean {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--apply") return true;
  throw new UpdateCommandError("arguments");
}

function controlledAsset(path: string): string {
  if (!existsSync(path)) throw new UpdateCommandError("trust-assets");
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new UpdateCommandError("trust-assets");
  return path;
}

export function runControlledUpdateCommand(options: ControlledUpdateCommandOptions): UpdateCoordinatorResult {
  const packageRoot = realpathSync(resolve(options.packageRoot));
  const metadataPath = controlledAsset(join(packageRoot, "release", "metadata.json"));
  const pinnedPublicKeyPath = controlledAsset(join(packageRoot, "release", "vibebloat.pub"));
  const platform = options.platform ?? process.platform;
  const standaloneSelfTarget = options.selfCommand.length === 1;
  if (options.apply && !standaloneSelfTarget) throw new UpdateCommandError("standalone");
  return coordinateUpdate({
    binaryPath: options.selfCommand[0] ?? process.execPath,
    communityGuardDirectory: options.communityGuardDirectory,
    releaseDirectory: packageRoot,
    metadataText: readFileSync(metadataPath, "utf8"),
    pinnedPublicKey: readFileSync(pinnedPublicKeyPath),
    currentVersion: options.currentVersion,
    run: options.run,
    doctor: options.doctor,
    apply: options.apply,
    platform,
    ...(platform === "win32" ? { windowsSelfUpdateTarget: standaloneSelfTarget } : {}),
    ...(options.scheduleWindowsSwap ? { scheduleWindowsSwap: options.scheduleWindowsSwap } : {}),
  });
}

export function formatUpdateCommandResult(result: UpdateCoordinatorResult): string {
  return result.scheduled
    ? `Update scheduled: ${result.currentVersion} -> ${result.candidateVersion}\nDoctor and rollback run after this process exits.\n`
    : result.applied
    ? `${formatUpdateSuccess(result.currentVersion, result.candidateVersion, result.diff)}\n`
    : `${result.preview}\n`;
}

export function formatUpdateCommandFailure(error: unknown): string {
  if (error instanceof UpdateCoordinatorError) return formatUpdateError(error);
  if (error instanceof UpdateCommandError && error.code === "arguments") {
    return "WHAT failed: update command was rejected.\nWHY: expected no arguments or --apply.\nFIX: vibebloat update\n";
  }
  if (error instanceof UpdateCommandError && error.code === "standalone") {
    return "WHAT failed: update was not applied.\nWHY: replacing VibeBloat requires the signed standalone executable.\nFIX: npx vibebloat@latest update\n";
  }
  return "WHAT failed: update trust check stopped.\nWHY: installed package lacks controlled release metadata or pinned public key.\nFIX: npx vibebloat@latest update\n";
}
