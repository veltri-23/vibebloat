import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DoctorFinding {
  status: "error" | "ok";
  check: "proof" | "claude-hook" | "codex-hook";
  message: string;
}

export interface DoctorOptions {
  guardDirectory: string;
  hookConfigs: { claude: string; codex: string };
}

export function runDoctor(options: DoctorOptions): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const proofPath = join(options.guardDirectory, "proof.json");
  if (!existsSync(proofPath)) findings.push({ status: "error", check: "proof", message: "No runner-written proof marker found." });
  if (!options.hookConfigs.claude.includes("vibebloat")) findings.push({ status: "error", check: "claude-hook", message: "Claude Code hook is missing." });
  if (!options.hookConfigs.codex.includes("vibebloat")) findings.push({ status: "error", check: "codex-hook", message: "Codex hook is missing." });
  return findings;
}
