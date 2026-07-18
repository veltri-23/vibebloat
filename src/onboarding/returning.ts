import type { GatePrompt } from "./assist";

export type ReturningChoice = "problem" | "project" | "manage" | "catch-up";
export type ReturningGate = "R0" | "R1" | "R2" | "R3" | "R4";

const returningGates: Record<ReturningGate, GatePrompt> = {
  R0: { question: "Welcome back. I set you up [3 weeks] ago — you've got [10] rules running and [7] have kicked in since. What brings you back today?", options: ["Something broke or a new problem", "A new project or tool", "Clean up or change my rules", "Just checking in / catch me up"] },
  R1: { question: "Tell me what happened. Was it your AI, or did something break on its own? Point me to it if you can.", options: [] },
  R2: { question: "", options: [] },
  R3: { question: "You've overridden `[git-stash]` 4 times — want me to relax it to a warning?", options: [] },
  R4: { question: "Since [date]: [2] new repeat mistakes, [1] rule gone stale. Want me to handle them?", options: [] },
};

export function returningRoute(choice: ReturningChoice): Exclude<ReturningGate, "R0"> {
  return { problem: "R1", project: "R2", manage: "R3", "catch-up": "R4" }[choice];
}

export function getReturningGate(gate: ReturningGate): GatePrompt {
  return returningGates[gate];
}

export function nextReturningGate(gate: ReturningGate, choice: ReturningChoice): ReturningGate | undefined {
  return gate === "R0" ? returningRoute(choice) : undefined;
}
