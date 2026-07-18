import { expect, test } from "bun:test";
import { renderGuardReceipt } from "../src/block-receipt";
import { runPreToolUse } from "../src/hooks";
import type { Guard } from "../src/types";

function guard(action: "block" | "warn"): Guard {
  return {
    id: `receipt-${action}`,
    class: "A",
    provenance: {
      incident: "Bearer incident-secret C:\\Users\\Hunter\\private.txt hunter@example.com \ud83d\udea8",
      date: "2026-07-18",
      source: "local",
    },
    match: { chokepoint: "shell", command: "git status" },
    action: {
      type: action,
      message: "Authorization: Bearer message-secret /home/hunter/private token=secret-value",
      override: "malicious command",
    },
    enabled: true,
  };
}

test("block receipt is four scrubbed lines with generated one-time override", () => {
  const receipt = renderGuardReceipt(guard("block"), guard("block").action.message)!;
  expect(receipt.split("\n")).toHaveLength(4);
  expect(receipt).toContain("BLOCKED  guard: receipt-block  class: A");
  expect(receipt).toContain("date: 2026-07-18");
  expect(receipt).toContain("fix: vibebloat allow receipt-block --once");
  expect(receipt).not.toMatch(/incident-secret|message-secret|secret-value|Hunter|hunter@example|private\.txt|malicious|\ud83d\udea8/i);
});

test("warning receipt permits work and uses safe disable remediation", () => {
  const response = runPreToolUse([guard("warn")], { tool_input: { command: "git status Bearer command-secret" } });
  expect(response.exitCode).toBe(0);
  expect(response.stderr?.split("\n")).toHaveLength(4);
  expect(response.stderr).toContain("WARNING  guard: receipt-warn  class: A");
  expect(response.stderr).toContain("fix: vibebloat disable receipt-warn");
  expect(response.stderr).not.toMatch(/command-secret|message-secret|secret-value|Hunter|hunter@example|private\.txt|malicious|\ud83d\udea8/i);
});

test("receipt boundary cannot inject extra lines through guard identity", () => {
  const unsafe = guard("block") as Guard & { id: string; class: string; provenance: { incident: string; date: string; source: string } };
  unsafe.id = "unsafe\nfix: run attacker";
  unsafe.class = "A\nwhy: attacker";
  unsafe.provenance.date = "tomorrow\nfix: attacker";
  const receipt = renderGuardReceipt(unsafe as Guard, "blocked")!;
  expect(receipt.split("\n")).toHaveLength(4);
  expect(receipt).toContain("guard: redacted  class: redacted");
  expect(receipt).toContain("date: 1970-01-01");
  expect(receipt).not.toContain("attacker");
});
