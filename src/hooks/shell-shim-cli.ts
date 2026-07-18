import { createFiringRecorder } from "../audit/firings";
import { disabledGuardIds } from "../cli/disable";
import { globalGuardHome, guardDirectories } from "../guard-home";
import { loadGuards } from "../guard-loader";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../guards";
import { formatGuardRuntimeFailure } from "../hooks";
import { Runtime } from "../runtime";
import type { Guard } from "../types";
import { runShellShim } from "./shell-shim";
import {
  captureGitTreeSnapshot,
  detectLiveGitIncident,
  isLiveIncidentCandidate,
  launchLiveCompileProposal,
  type GitTreeSnapshot,
} from "../compiler/live-incident";
import { onboardingHome } from "../guard-home";
import { loadOnboardingState } from "../onboarding/state";
import { fileURLToPath } from "node:url";

const builtInGuards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];

function runtimeGuards(): Guard[] {
  const installed = guardDirectories().flatMap(loadGuards);
  const builtInIds = new Set(builtInGuards.map((guard) => guard.id));
  const seenIds = new Set(builtInIds);
  const duplicate = installed.find((guard) => seenIds.has(guard.id) || !seenIds.add(guard.id));
  if (duplicate) throw new Error(`Installed guard duplicates built-in id: ${duplicate.id}`);
  return [...builtInGuards, ...installed];
}

const [gitExecutable, ...arguments_] = process.argv.slice(2);
if (!gitExecutable) {
  process.stderr.write("WHAT failed: real git executable was not supplied.\nWHY: shell shim must avoid invoking itself.\nFIX: reinstall the VibeBloat shell shim with an absolute git path.\n");
  process.exit(2);
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
    process.exit(response.exitCode);
  }
  if (response.localWarning) process.stderr.write(`${response.localWarning}\n`);
} catch {
  process.stderr.write(`${formatGuardRuntimeFailure("shell guard evaluation stopped")}\n`);
  process.exit(2);
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
    const incident = detectLiveGitIncident({ command, exitCode: 0, before, after, occurredAt: new Date() });
    if (incident) {
      launchLiveCompileProposal(incident, {
        scope: liveScope,
        cliPath: fileURLToPath(new URL("../cli.ts", import.meta.url)),
      });
      process.stderr.write(`Live incident detected: ${incident.condition} (${incident.recency}).\nBackground guard proposal scheduled; enforcement unchanged pending approval.\nReview later: vibebloat approve-live ${incident.incident_id}\n`);
    }
  } catch {
    process.stderr.write("WHAT failed: live incident proposal stopped.\nWHY: Post-command detection or local proposal proof failed.\nFIX: vibebloat doctor\n");
  }
}
process.exit(result.exitCode ?? 1);
