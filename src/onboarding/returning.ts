export type ReturningChoice = "problem" | "project" | "manage" | "catch-up";
export type ReturningGate = "R1" | "R2" | "R3" | "R4";

export function returningRoute(choice: ReturningChoice): ReturningGate {
  return { problem: "R1", project: "R2", manage: "R3", "catch-up": "R4" }[choice];
}
