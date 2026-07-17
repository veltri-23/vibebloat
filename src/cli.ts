import { disableGuard, disabledGuardIds } from "./cli/disable";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "./guards";
import { runPreToolUse } from "./hooks";
import { Runtime } from "./runtime";
import type { Event, Guard } from "./types";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];
const mode = process.argv[2];

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

process.stderr.write("WHAT failed: expected eval, hook, or disable.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts disable <guard-id>\n");
process.exit(1);
