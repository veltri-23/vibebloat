import { compileGuard } from "../compiler/codex-fill";
import { syntheticEvent } from "../compiler/synthetic-event";
import { rankIncidents, type IncidentManifest } from "../ingest/rank";
import { prefilterCandidates } from "../ingest/prefilter";
import { Runtime } from "../runtime";
import { runPreToolUse } from "../hooks";
import type { Guard } from "../types";

import { builtinPresidioScrubber, builtinGitleaksScrubber } from "../scrub/builtin";
import type { HistoryChunk } from "../ingest/types";
import { sampleHistory, samplePrecomputedIncidents, SAMPLE_LABEL } from "./history";

export interface DemoStep {
  label: string;
  detail: string;
}

export interface DemoBlock {
  /** The command an agent tried, exactly as a hook would receive it. */
  command: string;
  /** Exit code the agent's hook process receives. 2 means blocked. */
  exitCode: number;
  receipt: string;
  /** The same guard's verdict delivered to a different agent, when applicable. */
  crossAgent?: string;
}

export interface DemoAllowed {
  command: string;
  exitCode: number;
}

export interface DemoResult {
  steps: DemoStep[];
  receipts: string[];
  blocks: DemoBlock[];
  /** Safe variants proving the guard is scoped, not a blanket ban. */
  allowed: DemoAllowed[];
  mined: "model" | "precomputed";
  incidents: IncidentManifest[];
}

/** A genuine second evaluation bound to Codex, so the deny is earned. */
function codexDeny(guards: Guard[], payload: unknown): string | undefined {
  const verdict = runPreToolUse(guards, payload, new Runtime(), "codex");
  if (verdict.exitCode !== 2 || !verdict.stderr) return undefined;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: verdict.stderr,
    },
  });
}

/**
 * The same command minus the flag that made it destructive, to show the guard
 * is precise rather than a blanket ban. Positional arguments are kept, so
 * `docker compose down -v` demonstrates against `docker compose down` rather
 * than a bare `docker compose` nobody would type.
 */
function safeVariant(command: string | undefined, args: readonly string[] | undefined): string | undefined {
  if (!command || !args?.length) return undefined;
  const positional = args.filter((argument) => !argument.startsWith("-"));
  return [command, ...positional].join(" ");
}

export type DemoMiner = (candidates: HistoryChunk[]) => Promise<IncidentManifest[]>;

/**
 * Stamps an incident as sample data on every field that reaches the screen.
 *
 * Applied to live-mined findings as well as precomputed ones. The default path
 * auto-detects an agent CLI and mines for real, so the ids and prose in the
 * block a judge would screenshot are model-invented and carried no marker at
 * all -- and a live run dates them today, which reads as more authentic than
 * the backdated fallback, not less. Marking only the input session ids was not
 * enough: none of them appear in a receipt.
 */
function markAsSample(incident: IncidentManifest): IncidentManifest {
  const id = incident.incident_id.startsWith("sample-") ? incident.incident_id : `sample-${incident.incident_id}`;
  const condition = /^\[sample\]/i.test(incident.condition) ? incident.condition : `[sample] ${incident.condition}`;
  return { ...incident, incident_id: id, condition };
}

/**
 * Runs the real pipeline over the sample corpus so someone with no history of
 * their own can still see the whole loop end to end.
 *
 * Scrubbing, prefiltering, compiling and matching are the production code
 * paths, not a script. Only the mining step falls back: with no model
 * configured it uses the corpus's precomputed findings, and reports that it
 * did, because presenting canned findings as a live result would be exactly
 * the dishonesty this product is built against.
 */
export async function runSampleDemo(miner?: DemoMiner): Promise<DemoResult> {
  const history = sampleHistory();
  const steps: DemoStep[] = [{ label: "read", detail: `${history.length} messages across ${new Set(history.map((chunk) => chunk.sessionId)).size} sessions (${SAMPLE_LABEL})` }];

  const presidio = builtinPresidioScrubber();
  const gitleaks = builtinGitleaksScrubber();
  const scrubbed: HistoryChunk[] = [];
  for (const chunk of history) {
    scrubbed.push({ ...chunk, content: await gitleaks(await presidio(chunk.content)) });
  }
  steps.push({ label: "scrub", detail: "secrets removed before anything reaches a model" });

  const candidates = prefilterCandidates(scrubbed);
  steps.push({ label: "prefilter", detail: `${candidates.length} of ${scrubbed.length} messages carry an incident signal` });

  let incidents: IncidentManifest[] = [];
  let mined: DemoResult["mined"] = "precomputed";
  let minerError: string | undefined;
  if (miner) {
    try {
      incidents = await miner(candidates);
      mined = "model";
    } catch (error) {
      // A stale key or an offline endpoint must not take the demo down with
      // it: showing the loop is the whole point of this command.
      minerError = error instanceof Error ? error.message : "model command failed";
    }
  }
  if (mined === "model") {
    steps.push({ label: "mine", detail: `model found ${incidents.length} repeated ${incidents.length === 1 ? "mistake" : "mistakes"}` });
  } else {
    incidents = samplePrecomputedIncidents();
    steps.push({
      label: "mine",
      detail: minerError
        ? `model failed (${minerError}), using the sample's ${incidents.length} precomputed findings`
        : `no model configured, using the sample's ${incidents.length} precomputed findings`,
    });
  }

  const ranked = rankIncidents(incidents).map(markAsSample);
  const guards = ranked.map((incident) => compileGuard(incident, incident.severity >= 4 ? "high" : "low"));
  const receipts: string[] = [];
  const blocks: DemoBlock[] = [];
  const allowed: DemoAllowed[] = [];

  for (const [index, guard] of guards.entries()) {
    const event = syntheticEvent(guard);
    // The real hook entry point, so the exit code shown is the one an agent
    // actually receives -- not a rendering of what it might have been.
    const payload = event.chokepoint === "shell"
      ? { tool_input: { command: event.command } }
      : { tool_input: { file_path: event.path } };
    const response = runPreToolUse(guards, payload, new Runtime(), "claude-code");
    if (response.exitCode !== 2 || !response.stderr) continue;

    const command = event.chokepoint === "shell" ? event.command! : `write ${event.path}`;
    receipts.push(response.stderr);
    blocks.push({
      command,
      exitCode: response.exitCode,
      receipt: response.stderr,
      // Codex takes a structured deny instead of exit 2: one guard, two wire
      // formats. Evaluated a second time through the real entry point rather
      // than re-wrapping the first verdict, so agent-scoped binding is
      // genuinely exercised instead of assumed.
      ...(index === 0 ? { crossAgent: codexDeny(guards, payload) } : {}),
    });

    const safe = safeVariant(guard.match.command, guard.match.argsContains ?? guard.match.argsAnyOf);
    if (safe && safe !== command) {
      const safeResponse = runPreToolUse(guards, { tool_input: { command: safe } }, new Runtime(), "claude-code");
      if (safeResponse.exitCode === 0) allowed.push({ command: safe, exitCode: 0 });
    }
  }

  steps.push({ label: "prove", detail: `${blocks.length} ${blocks.length === 1 ? "guard blocks" : "guards block"} the exact command that caused the incident, with exit code 2` });
  if (allowed.length > 0) {
    steps.push({ label: "allow", detail: `${allowed.length} safe ${allowed.length === 1 ? "variant" : "variants"} of the same ${allowed.length === 1 ? "command runs" : "commands run"} untouched` });
  }

  return { steps, receipts, blocks, allowed, mined, incidents: ranked };
}
