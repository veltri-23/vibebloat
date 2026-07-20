import { isAbsolute } from "node:path";
import { createFiringRecorder } from "../audit/firings";
import {
  captureGitTreeSnapshot,
  detectLiveGitIncident,
  isLiveIncidentCandidate,
  launchLiveCompileProposal,
  type GitTreeSnapshot,
} from "../compiler/live-incident";
import { disabledGuardIds } from "../cli/disable";
import { globalGuardHome, guardDirectories, onboardingHome } from "../guard-home";
import { loadGuards } from "../guard-loader";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../guards";
import { formatGuardRuntimeFailure } from "../hooks";
import { loadOnboardingState } from "../onboarding/state";
import { Runtime } from "../runtime";
import type { Guard } from "../types";
import { runShellShim } from "./shell-shim";

const builtInGuards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];

function runtimeGuards(): Guard[] {
  const installed = guardDirectories().flatMap(loadGuards);
  const builtInIds = new Set(builtInGuards.map((guard) => guard.id));
  const seenIds = new Set(builtInIds);
  const duplicate = installed.find((guard) => seenIds.has(guard.id) || !seenIds.add(guard.id));
  if (duplicate) throw new Error(`Installed guard duplicates built-in id: ${duplicate.id}`);
  return [...builtInGuards, ...installed];
}

export interface ShellShimHandlerOptions {
  cliCommand: readonly string[];
}

export function runShellShimCommand(
  gitExecutable: string | undefined,
  arguments_: readonly string[],
  options: ShellShimHandlerOptions,
): number {
  if (!gitExecutable || !isAbsolute(gitExecutable)) {
    process.stderr.write("WHAT failed: real git executable was not supplied.\nWHY: shell shim must avoid invoking itself.\nFIX: reinstall the VibeBloat shell shim with an absolute git path.\n");
    return 2;
  }
  if (options.cliCommand.length === 0 || !isAbsolute(options.cliCommand[0]!)) {
    process.stderr.write("WHAT failed: VibeBloat command was not supplied.\nWHY: shell shim cannot launch its local compiler safely.\nFIX: reinstall the VibeBloat shell shim.\n");
    return 2;
  }

  const command = `git ${arguments_.join(" ")}`;
  try {
    const response = runShellShim(runtimeGuards(), command, "bash", new Runtime(
      disabledGuardIds(),
      undefined,
      undefined,
      createFiringRecorder(globalGuardHome()),
    ));
    if (response.exitCode !== 0) {
      process.stderr.write(`${response.stderr}\n`);
      if (response.localWarning) process.stderr.write(`${response.localWarning}\n`);
      return response.exitCode;
    }
    if (response.localWarning) process.stderr.write(`${response.localWarning}\n`);
  } catch {
    process.stderr.write(`${formatGuardRuntimeFailure("shell guard evaluation stopped")}\n`);
    return 2;
  }

  let before: GitTreeSnapshot | undefined;
  let liveScope: "repo" | "machine" = "machine";
  if (isLiveIncidentCandidate(command)) {
    try {
      liveScope = loadOnboardingState(onboardingHome())?.scope ?? "machine";
      before = captureGitTreeSnapshot(process.cwd(), gitExecutable);
    } catch {
      process.stderr.write("WHAT failed: live incident observation skipped.\nWHY: Git tree state could not be captured before the command.\nFIX: vibebloat doctor\n");
    }
  }

  const result = Bun.spawnSync([gitExecutable, ...arguments_], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  if (before && result.exitCode === 0) {
    try {
      const after = captureGitTreeSnapshot(process.cwd(), gitExecutable);
      const incident = detectLiveGitIncident({ command, exitCode: 0, before, after, occurredAt: new Date(), cwd: process.cwd() });
      if (incident) {
        launchLiveCompileProposal(incident, { scope: liveScope, cliCommand: options.cliCommand });
        process.stderr.write(`Live incident detected: ${incident.condition} (${incident.recency}).\nBackground guard proposal scheduled; enforcement unchanged pending approval.\nReview later: vibebloat approve-live ${incident.incident_id}\n`);
      }
    } catch {
      process.stderr.write("WHAT failed: live incident proposal stopped.\nWHY: Post-command detection or local proposal proof failed.\nFIX: vibebloat doctor\n");
    }
  }
  return result.exitCode ?? 1;
}
