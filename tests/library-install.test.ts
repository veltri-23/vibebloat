import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installVerifiedGuard, installVerifiedGuardForScope } from "../src/library/install";
import { gitStashUntrackedGuard } from "../src/guards";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("library refuses guard install without runner proof", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-library-"));
  tempDirectories.push(directory);
  expect(() => installVerifiedGuard(directory, gitStashUntrackedGuard)).toThrow("proof");
  writeFileSync(join(directory, "proof.json"), JSON.stringify({ status: "pass" }));
  installVerifiedGuard(directory, gitStashUntrackedGuard);
  expect(JSON.parse(readFileSync(join(directory, "git-stash-untracked.json"), "utf8"))).toMatchObject({ id: "git-stash-untracked" });
});

test("library install targets the selected repo guard home", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-library-scope-"));
  tempDirectories.push(root);
  const project = join(root, "project");
  const guards = join(project, ".vibebloat", "guards");
  mkdirSync(guards, { recursive: true });
  writeFileSync(join(guards, "proof.json"), JSON.stringify({ status: "pass" }));

  installVerifiedGuardForScope("repo", gitStashUntrackedGuard, { USERPROFILE: join(root, "user") } as NodeJS.ProcessEnv, project);
  expect(JSON.parse(readFileSync(join(guards, "git-stash-untracked.json"), "utf8"))).toMatchObject({ id: "git-stash-untracked" });
});
