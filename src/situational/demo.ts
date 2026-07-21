import { match } from "../match";
import type { Event } from "../types";
import { gatherEventContext, hermesLiveTreeCheckoutGuard as guard } from "./live-tree-checkout";

const COMMAND = "git checkout -f main";

function line(label: string, event: Event): void {
  const verdict = match(guard, event);
  const tag = verdict.fired ? "BLOCKED" : "allowed";
  console.log(`${tag.padEnd(8)} ${label}`);
  if (verdict.fired && verdict.reason) console.log(`         why: ${verdict.reason}`);
}

console.log(`Guard: ${guard.id}  (one mistake, not a command class)`);
console.log(`Command under test: ${COMMAND}\n`);

// 1) Real, live read of THIS machine, right now. We are not in the hermes tree,
//    so the exact same command is allowed -- no false positive.
const live = gatherEventContext(COMMAND);
line(`LIVE read (cwd=${live.cwd}, unstaged=${live.hasUnstagedChanges}, hermes running=${live.runningProcesses?.some((p) => p.toLowerCase().includes("hermes")) ?? false})`, live);

// 2) The exact incident situation, reconstructed: in the tree, gateway live,
//    unstaged changes. This is the recurrence -- and only this is blocked.
const incident: Event = {
  chokepoint: "shell",
  command: COMMAND,
  cwd: "D:/AI/hermes/home",
  runningProcesses: ["hermes-gateway.exe", "code.exe", "chrome.exe"],
  hasUnstagedChanges: true,
};
line("INCIDENT (in hermes tree, gateway live, unstaged)", incident);

// 3) Same command, each single condition removed -> allowed. Proof it is scoped
//    to the situation, not the command.
line("same command, wrong repo        (cwd=D:/AI/projects/x)", { ...incident, cwd: "D:/AI/projects/x" });
line("same command, no gateway running (processes=[code.exe])", { ...incident, runningProcesses: ["code.exe"] });
line("same command, clean tree         (unstaged=false)", { ...incident, hasUnstagedChanges: false });

// 4) A safe command in the exact incident context -> allowed. The guard does not
//    blanket-block the tree; it blocks the one dangerous shape.
line("safe variant in incident context (git checkout -b hotfix)", { ...incident, command: "git checkout -b hotfix" });
