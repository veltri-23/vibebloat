import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface DoctorFinding {
  status: "error" | "ok";
  check: "proof" | "claude-hook" | "codex-hook";
  message: string;
}

export interface DoctorOptions {
  guardDirectory?: string;
  guardDirectories?: readonly string[];
  hookConfigs: { claude: string; codex: string };
}

export function runDoctor(options: DoctorOptions): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const guardDirectories = options.guardDirectories ?? (options.guardDirectory ? [options.guardDirectory] : []);
  const hasProof = guardDirectories.some((directory) => existsSync(join(directory, "proof.json")));
  if (!hasProof) findings.push({ status: "error", check: "proof", message: "No runner-written proof marker found." });
  if (!options.hookConfigs.claude.includes("vibebloat")) findings.push({ status: "error", check: "claude-hook", message: "Claude Code hook is missing." });
  if (!options.hookConfigs.codex.includes("vibebloat")) findings.push({ status: "error", check: "codex-hook", message: "Codex hook is missing." });
  return findings;
}
