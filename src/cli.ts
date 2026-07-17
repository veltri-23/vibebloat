import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "./guards";
import { runPreToolUse } from "./hooks";
import { Runtime } from "./runtime";
import type { Event, Guard } from "./types";

const guards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];
const mode = process.argv[2];
const input = await Bun.stdin.text();

if (mode === "eval") {
  const { guard, event } = JSON.parse(input) as { guard: Guard; event: Event };
  process.stdout.write(`${JSON.stringify(new Runtime().evaluate([guard], event))}\n`);
  process.exit(0);
}

if (mode === "hook") {
  const response = runPreToolUse(guards, JSON.parse(input));
  if (response.stderr) process.stderr.write(`${response.stderr}\n`);
  process.exit(response.exitCode);
}

process.stderr.write("WHAT failed: expected eval or hook.\nWHY: no supported mode supplied.\nFIX: bun src/cli.ts eval < input.json\n");
process.exit(1);
