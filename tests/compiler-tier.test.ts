import { expect, test } from "bun:test";
import { actionTypeForConfidence } from "../src/compiler/tiering";

test("high confidence compiles to block and low confidence to warn", () => {
  expect(actionTypeForConfidence("high")).toBe("block");
  expect(actionTypeForConfidence("low")).toBe("warn");
});
