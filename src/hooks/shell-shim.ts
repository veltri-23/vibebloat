import { Runtime } from "../runtime";
import type { Guard } from "../types";
import type { HookResponse } from "../hooks";

export function runShellShim(guards: Guard[], command: string, _shell: "bash" | "zsh" | "fish" | "pwsh", runtime = new Runtime()): HookResponse {
  const verdict = runtime.evaluate(guards, { chokepoint: "shell", command });
  return verdict.blocked ? { exitCode: 2, stderr: verdict.reason } : { exitCode: 0 };
}
