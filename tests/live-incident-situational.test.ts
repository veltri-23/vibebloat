import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { match } from "../src/match";
import { parseGuard } from "../src/schema";
import { detectLiveGitIncident, scheduleLiveCompileProposal, type GitTreeSnapshot } from "../src/compiler/live-incident";
import type { Event } from "../src/types";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const before: GitTreeSnapshot = { untrackedPaths: ["launch.cmd", "ops/start.ps1"] };
const after: GitTreeSnapshot = { untrackedPaths: [] };
const INCIDENT_TREE = "D:/AI/hermes/home";

test("an observed incident records the tree it happened in", () => {
  const incident = detectLiveGitIncident({ command: "git clean -fd", exitCode: 0, before, after, occurredAt: new Date("2026-07-18T12:00:00.000Z"), cwd: INCIDENT_TREE });
  expect(incident?.context_cwd_under).toBe(INCIDENT_TREE);
});

test("an observation with no tree stays generic (backward compatible)", () => {
  const incident = detectLiveGitIncident({ command: "git clean -fd", exitCode: 0, before, after, occurredAt: new Date("2026-07-18T12:00:00.000Z") });
  expect(incident?.context_cwd_under).toBeUndefined();
});

test("the auto-compiled guard is situational: blocks in the incident tree, allowed elsewhere", async () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-situational-"));
  temporaryDirectories.push(root);
  const project = join(root, "project");

  const incident = detectLiveGitIncident({ command: "git clean -fd", exitCode: 0, before, after, occurredAt: new Date("2026-07-18T12:00:00.000Z"), cwd: INCIDENT_TREE })!;
  let task: (() => void) | undefined;
  const scheduled = scheduleLiveCompileProposal(incident, { cwd: project, now: new Date("2026-07-18T12:00:00.000Z"), schedule: (next) => { task = next; } });
  task?.();
  const result = await scheduled.completion;
  expect(result.status).toBe("proposed");
  expect(result.proposalPath).toBeDefined();

  // Read the proposed guard the loop actually wrote and prove its behavior.
  const guard = parseGuard(JSON.parse(readFileSync(result.proposalPath!, "utf8")));

  expect(guard.match.context?.cwdUnder).toBe(INCIDENT_TREE);

  const command = "git clean -fd";
  const inTree: Event = { chokepoint: "shell", command, cwd: `${INCIDENT_TREE}/sub` };
  const elsewhere: Event = { chokepoint: "shell", command, cwd: "D:/AI/projects/other" };
  expect(match(guard, inTree).fired).toBe(true); // recurrence, same tree -> blocked
  expect(match(guard, elsewhere).fired).toBe(false); // same command, different tree -> allowed
});
