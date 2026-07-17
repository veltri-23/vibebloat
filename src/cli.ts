import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { disableGuard, disabledGuardIds } from "./cli/disable";
import { runDoctor } from "./doctor/checks";
import { forgetEmail } from "./growth/email-capture";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "./guards";
import { runPreToolUse } from "./hooks";
import { Runtime } from "./runtime";
import type { Event, Guard } from "./types";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];
const mode = process.argv[2];

function configText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

if (mode === "doctor") {
  const home = process.env.VIBEBLOAT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".vibebloat");
  const claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".claude");
  const codexHome = process.env.CODEX_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex");
  const findings = runDoctor({
    guardDirectory: join(home, "guards"),
    hookConfigs: { claude: configText(join(claudeHome, "settings.json")), codex: configText(join(codexHome, "config.toml")) },
  });
  if (findings.length === 0) {
    process.stdout.write("VibeBloat doctor: healthy.\n");
    process.exit(0);
  }
  process.stderr.write(`WHAT failed: doctor found ${findings.length} problem(s).\nWHY: ${findings.map((finding) => finding.message).join(" ")}\nFIX: vibebloat install\n`);
  process.exit(1);
}

if (mode === "email" && process.argv[3] === "--forget") {
  const home = process.env.VIBEBLOAT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".vibebloat");
  forgetEmail(home);
  process.stdout.write("Email removed.\n");
  process.exit(0);
}

if (mode === "disable") {
  try {
    disableGuard(process.argv[3] ?? "");
    process.stdout.write(`Disabled guard: ${process.argv[3]}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`WHAT failed: could not disable guard.\nWHY: ${error instanceof Error ? error.message : "unknown error"}\nFIX: vibebloat disable <guard-id>\n`);
    process.exit(1);
  }
}

const input = await Bun.stdin.text();

if (mode === "eval") {
  const { guard, event } = JSON.parse(input) as { guard: Guard; event: Event };
  process.stdout.write(`${JSON.stringify(new Runtime(disabledGuardIds()).evaluate([guard], event))}\n`);
  process.exit(0);
}

if (mode === "hook") {
  const response = runPreToolUse(guards, JSON.parse(input), new Runtime(disabledGuardIds()));
  if (response.exitCode === 2 && process.argv[3] === "--agent=codex") {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: response.stderr,
      },
    })}\n`);
    process.exit(0);
  }
  if (response.stderr) process.stderr.write(`${response.stderr}\n`);
  process.exit(response.exitCode);
}

process.stderr.write("WHAT failed: expected eval, hook, disable, doctor, or email.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts doctor\n");
process.exit(1);
