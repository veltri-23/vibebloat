import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitStashUntrackedGuard } from "../src/guards";
import { compileLive, compileLiveForScope } from "../src/compiler/live-compile";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("live compile writes a guard only after eval proves it fires", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-"));
  tempDirectories.push(directory);

  expect(compileLive(directory, gitStashUntrackedGuard, { chokepoint: "shell", command: "git stash -u" })).toEqual({ status: "pass" });
  expect(JSON.parse(readFileSync(join(directory, "git-stash-u.json"), "utf8"))).toMatchObject({ id: "git-stash-u" });
  expect(JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"))).toEqual({ status: "pass", cases: ["synthetic event fired"] });
});

test("live compile refuses to install an unproven guard", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-"));
  tempDirectories.push(directory);

  expect(compileLive(directory, gitStashUntrackedGuard, { chokepoint: "shell", command: "git status" })).toEqual({ status: "fail" });
  expect(() => readFileSync(join(directory, "git-stash-u.json"), "utf8")).toThrow();
});

test("live compile writes to the selected repo or machine guard home", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-live-scope-"));
  tempDirectories.push(root);
  const environment = { USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv;
  const project = join(root, "project");

  expect(compileLiveForScope("repo", gitStashUntrackedGuard, { chokepoint: "shell", command: "git stash -u" }, environment, project)).toEqual({ status: "pass" });
  expect(readFileSync(join(project, ".vibebloat", "guards", "git-stash-u.json"), "utf8")).toContain("git-stash-u");
  expect(compileLiveForScope("machine", gitStashUntrackedGuard, { chokepoint: "shell", command: "git stash -u" }, environment, project)).toEqual({ status: "pass" });
  expect(readFileSync(join(root, "user", ".vibebloat", "guards", "git-stash-u.json"), "utf8")).toContain("git-stash-u");
});
