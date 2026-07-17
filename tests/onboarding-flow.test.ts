import { expect, test } from "bun:test";
import { gateOrder, nextOrderedGate } from "../src/onboarding/flow";

test("first-run gates remain in locked order", () => {
  expect(gateOrder.slice(0, 8)).toEqual(["A0", "A1", "F0", "B1", "D1", "E1", "E2", "F1"]);
  expect(nextOrderedGate("F2.1")).toBe("F3");
  expect(nextOrderedGate("END")).toBeUndefined();
});
