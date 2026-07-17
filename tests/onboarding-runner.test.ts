import { expect, test } from "bun:test";
import { nextGateBatch } from "../src/onboarding/runner";

test("runner surfaces one to three ordered gates and never auto-selects", () => {
  expect(nextGateBatch(["A1", "F0", "B1", "D1"], 0, 3)).toEqual(["A1", "F0", "B1"]);
  expect(nextGateBatch(["A1", "F0"], 1, 3)).toEqual(["F0"]);
});
