import type { GatePrompt } from "./assist";

export type GateId = "A1" | "F0" | "B1";

const gates: Record<Exclude<GateId, "B1">, GatePrompt> = {
  A1: {
    question: "First: should I protect just this project, or watch your work everywhere on this machine?",
    options: ["Just this project", "Everywhere (recommended for solo devs)"],
  },
  F0: {
    question: "To catch mistakes I need to add two small helpers — a shortcut that watches commands, and a git safety check. Both are easy to remove any time. Okay to set those up?",
    options: ["Yes", "Tell me more first"],
  },
};

export function getGate(gate: Exclude<GateId, "B1">): GatePrompt {
  return gates[gate];
}

export function nextGate(gate: Exclude<GateId, "B1">, answer: string): GateId {
  if (gate === "A1") return "F0";
  return answer === "yes" ? "B1" : "F0";
}
