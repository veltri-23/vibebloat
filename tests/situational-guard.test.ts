import { expect, test } from "bun:test";
import { match } from "../src/match";
import { parseGuard } from "../src/schema";
import type { Event, Guard } from "../src/types";
import { gatherEventContext, hermesLiveTreeCheckoutGuard as guard } from "../src/situational/live-tree-checkout";

const COMMAND = "git checkout -f main";

const incident: Event = {
  chokepoint: "shell",
  command: COMMAND,
  cwd: "D:/AI/hermes/home",
  runningProcesses: ["hermes-gateway.exe", "code.exe"],
  hasUnstagedChanges: true,
};

test("the guard passes schema validation", () => {
  expect(() => parseGuard(guard)).not.toThrow();
});

test("fires on the exact recurrence of the mistake", () => {
  expect(match(guard, incident).fired).toBe(true);
});

test("does NOT fire when any single situational condition is absent", () => {
  expect(match(guard, { ...incident, cwd: "D:/AI/projects/other" }).fired).toBe(false); // wrong repo
  expect(match(guard, { ...incident, runningProcesses: ["code.exe"] }).fired).toBe(false); // no gateway
  expect(match(guard, { ...incident, hasUnstagedChanges: false }).fired).toBe(false); // clean tree
});

test("does NOT fire when the runtime facts are unknown (cannot confirm the situation)", () => {
  expect(match(guard, { chokepoint: "shell", command: COMMAND }).fired).toBe(false);
});

test("does NOT fire on a safe variant even inside the exact incident context", () => {
  expect(match(guard, { ...incident, command: "git checkout -b hotfix" }).fired).toBe(false);
});

test("a context-free guard with the same command fires everywhere (shows context is the narrowing)", () => {
  const generic: Guard = { ...guard, id: "generic-checkout", match: { chokepoint: "shell", command: "git checkout", argsAnyOf: ["-f", "--force"] } };
  expect(match(generic, { chokepoint: "shell", command: COMMAND, cwd: "D:/AI/projects/other" }).fired).toBe(true);
});

test("the collector attaches real runtime facts to an event", () => {
  const event = gatherEventContext(COMMAND, process.cwd());
  expect(event.command).toBe(COMMAND);
  expect(event.cwd).toBe(process.cwd());
  expect(Array.isArray(event.runningProcesses)).toBe(true);
  expect(typeof event.hasUnstagedChanges).toBe("boolean");
});
