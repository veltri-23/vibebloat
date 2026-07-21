import { expect, test } from "bun:test";
import { enrichEventWithContext, neededFacts } from "../src/situational/context";
import { bindingFromPreToolUse } from "../src/hooks";
import { hermesLiveTreeCheckoutGuard } from "../src/situational/live-tree-checkout";
import type { Event, Guard } from "../src/types";

const plainGuard: Guard = {
  schemaVersion: 1, id: "plain-checkout", class: "A",
  provenance: { incident: "x", date: "2026-07-20", source: "t" },
  match: { chokepoint: "shell", command: "git checkout", argsAnyOf: ["-f"] },
  action: { type: "block", message: "m", override: "o" }, enabled: true,
};

test("no situational guard installed -> event returned untouched, zero I/O", () => {
  const event: Event = { chokepoint: "shell", command: "git checkout -f main" };
  expect(enrichEventWithContext(event, [plainGuard])).toBe(event); // same reference = early return, no scan
});

test("situational guard whose binary is irrelevant to the command -> no scan", () => {
  const event: Event = { chokepoint: "shell", command: "npm test" };
  expect(neededFacts([hermesLiveTreeCheckoutGuard], event)).toEqual({ cwd: false, processes: false, unstaged: false });
  expect(enrichEventWithContext(event, [hermesLiveTreeCheckoutGuard])).toBe(event);
});

test("relevant situational guard -> exactly the needed facts are gathered", () => {
  const event: Event = { chokepoint: "shell", command: "git checkout -f main" };
  expect(neededFacts([hermesLiveTreeCheckoutGuard], event)).toEqual({ cwd: true, processes: true, unstaged: true });
  const out = enrichEventWithContext(event, [hermesLiveTreeCheckoutGuard]);
  expect(out.cwd).toBe(process.cwd());
  expect(Array.isArray(out.runningProcesses)).toBe(true);
  expect(typeof out.hasUnstagedChanges).toBe("boolean");
});

test("hook enriches the event when a situational guard is present", () => {
  const binding = bindingFromPreToolUse([hermesLiveTreeCheckoutGuard], { tool_name: "Bash", tool_input: { command: "git checkout -f main" } });
  expect(binding?.event.cwd).toBe(process.cwd());
});

test("hook leaves the event lean when only context-free guards are present", () => {
  const binding = bindingFromPreToolUse([plainGuard], { tool_name: "Bash", tool_input: { command: "git checkout -f main" } });
  expect(binding?.event.cwd).toBeUndefined();
  expect(binding?.event.runningProcesses).toBeUndefined();
});
