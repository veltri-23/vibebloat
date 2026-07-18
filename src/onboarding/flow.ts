import type { GateId } from "./gates";

export const gateOrder = [
  "A0", "A1", "F0", "B1", "D1", "E1", "E2", "F1", "F1b", "F2", "F2.1", "F3", "F4", "F5", "F6",
  "SCAN", "G-empty", "I1", "I-zero", "J0", "J1", "J2", "J3", "K", "L1", "M", "N1", "N2", "O1", "O2", "O3", "END",
] as const satisfies readonly GateId[];

export type FirstRunGate = typeof gateOrder[number];

export function nextOrderedGate(gate: FirstRunGate): FirstRunGate | undefined {
  const index = gateOrder.indexOf(gate);
  return index >= 0 ? gateOrder[index + 1] : undefined;
}
