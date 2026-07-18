import { expect, test } from "bun:test";
import { executeReturningAction, recordReturningConversation, returningAction } from "../../src/onboarding/returning";

test("returning gates dispatch their locked incremental actions", () => {
  const called: string[] = [];
  expect(executeReturningAction("R1", { "scan-problem": (action) => called.push(action.kind) })).toEqual({ kind: "scan-problem", sinceLastRun: true, compareExistingRules: true });
  expect(returningAction("R2")).toEqual({ kind: "discover-project-or-tool", targetedScan: true, scopedRules: true });
  expect(returningAction("R3").kind).toBe("manage-rules");
  expect(returningAction("R4")).toEqual({ kind: "catch-up", runDoctor: true, incrementalScan: true });
  expect(called).toEqual(["scan-problem"]);
});

test("return conversations persist only after the F1b Sure choice", () => {
  const allowed = recordReturningConversation({ gate: "END", answers: { F1b: "Sure" } }, { reason: "catch-up" });
  const denied = recordReturningConversation({ gate: "END", answers: { F1b: "No thanks" } }, { reason: "catch-up" });
  expect(allowed.returningConversations).toEqual([{ reason: "catch-up" }]);
  expect(denied.returningConversations).toBeUndefined();
});
