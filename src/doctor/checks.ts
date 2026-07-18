import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Guard, GuardAgent } from "../types";

export interface DoctorFinding {
  status: "error" | "ok";
  check: "proof" | "claude-hook" | "codex-hook" | "guard-bind";
  message: string;
}

export interface DoctorOptions {
  guardDirectory?: string;
  guardDirectories?: readonly string[];
  guards?: readonly Guard[];
  installedAgents?: readonly GuardAgent[];
  hookConfigs: { claude: string; codex: string; hermes?: string; openclaw?: string };
}

function hasChokepoint(agent: GuardAgent, hookConfigs: DoctorOptions["hookConfigs"]): boolean {
  switch (agent) {
    case "claude-code": return hookConfigs.claude.includes("vibebloat");
    case "codex": return hookConfigs.codex.includes("vibebloat") && /plugin_hooks\s*=\s*true/.test(hookConfigs.codex);
    case "hermes": return hookConfigs.hermes?.includes("vibebloat-hermes-pre-tool-call") === true;
    case "openclaw": return hookConfigs.openclaw?.includes("vibebloat") === true;
  }
}

export function runDoctor(options: DoctorOptions): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const guardDirectories = options.guardDirectories ?? (options.guardDirectory ? [options.guardDirectory] : []);
  const hasProof = guardDirectories.some((directory) => existsSync(join(directory, "proof.json")));
  if (!hasProof) findings.push({ status: "error", check: "proof", message: "No runner-written proof marker found." });
  if (!hasChokepoint("claude-code", options.hookConfigs)) findings.push({ status: "error", check: "claude-hook", message: "Claude Code hook is missing." });
  if (!hasChokepoint("codex", options.hookConfigs)) findings.push({ status: "error", check: "codex-hook", message: "Codex hook is missing." });
  const installedAgents = options.installedAgents ?? ["claude-code", "codex"];
  const missingByAgent = new Map<GuardAgent, string[]>();
  for (const guard of options.guards ?? []) {
    if (!guard.enabled) continue;
    const requiredAgents = guard.binds?.length
      ? guard.binds.filter((agent) => installedAgents.includes(agent))
      : installedAgents;
    for (const agent of requiredAgents) {
      if (hasChokepoint(agent, options.hookConfigs)) continue;
      const guardIds = missingByAgent.get(agent) ?? [];
      guardIds.push(guard.id);
      missingByAgent.set(agent, guardIds);
    }
  }
  for (const [agent, guardIds] of missingByAgent) {
    if (agent === "claude-code" || agent === "codex") continue;
    findings.push({
      status: "error",
      check: "guard-bind",
      message: `Guards ${guardIds.join(", ")} require ${agent}, but doctor could not verify its native chokepoint.`,
    });
  }
  return findings;
}
