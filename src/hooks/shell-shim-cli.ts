import { join } from "node:path";
import { disabledGuardIds } from "../cli/disable";
import { loadGuards } from "../guard-loader";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../guards";
import { Runtime } from "../runtime";
import type { Guard } from "../types";
import { runShellShim } from "./shell-shim";

const builtInGuards: Guard[] = [gitStashUntrackedGuard, mcpConfigWrongFileGuard];

function homeDirectory(): string {
  return process.env.VIBEBLOAT_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".vibebloat");
}

function runtimeGuards(): Guard[] {
  const installed = loadGuards(join(homeDirectory(), "guards"));
  const builtInIds = new Set(builtInGuards.map((guard) => guard.id));
  const duplicate = installed.find((guard) => builtInIds.has(guard.id));
  if (duplicate) throw new Error(`Installed guard duplicates built-in id: ${duplicate.id}`);
  return [...builtInGuards, ...installed];
}

const [gitExecutable, ...arguments_] = process.argv.slice(2);
if (!gitExecutable) {
  process.stderr.write("WHAT failed: real git executable was not supplied.\nWHY: shell shim must avoid invoking itself.\nFIX: reinstall the VibeBloat shell shim with an absolute git path.\n");
  process.exit(2);
}

try {
  const response = runShellShim(runtimeGuards(), `git ${arguments_.join(" ")}`, "bash", new Runtime(disabledGuardIds()));
  if (response.exitCode !== 0) {
    process.stderr.write(`${response.stderr}\n`);
    process.exit(response.exitCode);
  }
} catch (error) {
  process.stderr.write(`Guard runtime failed closed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exit(2);
}

const result = Bun.spawnSync([gitExecutable, ...arguments_], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exit(result.exitCode ?? 1);
