import { Runtime } from "../runtime";
import { enrichEventWithContext } from "../situational/context";
import type { Guard } from "../types";
import { hookResponseForVerdict, type HookResponse } from "../hooks";

export function runShellShim(guards: Guard[], command: string, _shell: "bash" | "zsh" | "fish" | "pwsh", runtime = new Runtime(), gitExecutable: string = "git"): HookResponse {
  const event = enrichEventWithContext({ chokepoint: "shell", command }, guards, gitExecutable);
  const verdict = runtime.evaluate(guards, event);
  return hookResponseForVerdict(verdict);
}
