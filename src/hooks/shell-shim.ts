import { Runtime } from "../runtime";
import type { Guard } from "../types";
import { hookResponseForVerdict, type HookResponse } from "../hooks";

export function runShellShim(guards: Guard[], command: string, _shell: "bash" | "zsh" | "fish" | "pwsh", runtime = new Runtime()): HookResponse {
  const verdict = runtime.evaluate(guards, { chokepoint: "shell", command });
  return hookResponseForVerdict(verdict);
}
