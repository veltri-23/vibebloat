import { expect, test } from "bun:test";
import { returningRoute } from "../src/onboarding/returning";

test("returning menu routes each locked choice", () => {
  expect(returningRoute("problem")).toBe("R1");
  expect(returningRoute("project")).toBe("R2");
  expect(returningRoute("manage")).toBe("R3");
  expect(returningRoute("catch-up")).toBe("R4");
});
