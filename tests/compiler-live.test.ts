import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitStashUntrackedGuard } from "../src/guards";
import { compileLive } from "../src/compiler/live-compile";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("live compile writes a guard only after eval proves it fires", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-"));
  tempDirectories.push(directory);

  expect(compileLive(directory, gitStashUntrackedGuard, { chokepoint: "shell", command: "git stash -u" })).toEqual({ status: "pass" });
  expect(JSON.parse(readFileSync(join(directory, "git-stash-untracked.json"), "utf8"))).toMatchObject({ id: "git-stash-untracked" });
  expect(JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"))).toEqual({ status: "pass", cases: ["synthetic event fired"] });
});

test("live compile refuses to install an unproven guard", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-"));
  tempDirectories.push(directory);

  expect(compileLive(directory, gitStashUntrackedGuard, { chokepoint: "shell", command: "git status" })).toEqual({ status: "fail" });
  expect(() => readFileSync(join(directory, "git-stash-untracked.json"), "utf8")).toThrow();
});
