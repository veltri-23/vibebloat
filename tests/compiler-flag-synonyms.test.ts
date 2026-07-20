import { expect, test } from "bun:test";
import { flagSpellings, widenArgs } from "../src/compiler/flag-synonyms";

test("knows the long form of a destructive short flag", () => {
  expect(flagSpellings("git stash", "-u")).toContain("--include-untracked");
  expect(flagSpellings("docker compose", "-v")).toContain("--volumes");
});

test("does not invent synonyms it has no basis for", () => {
  expect(flagSpellings("git stash", "-q")).toEqual(["-q"]);
  expect(flagSpellings("some-tool", "-u")).toEqual(["-u"]);
});

test("scopes synonyms by command so -v is not misread elsewhere", () => {
  // -v is --volumes to docker compose and --verbose almost everywhere else.
  expect(flagSpellings("tar", "-v")).toEqual(["-v"]);
  expect(flagSpellings("docker compose", "-v")).toContain("--volumes");
});

test("a single-flag incident widens to every spelling", () => {
  expect(widenArgs("git stash", ["-u"])).toEqual({ argsAnyOf: ["-u", "--include-untracked"] });
});

test("a multi-flag incident keeps exact semantics", () => {
  // "all of these" cannot be loosened into "any of these" without blocking
  // commands the incident never covered.
  expect(widenArgs("docker compose", ["down", "-v"])).toEqual({ argsContains: ["down", "-v"] });
});

test("no args means no argument constraint", () => {
  expect(widenArgs("rm -rf", [])).toEqual({});
  expect(widenArgs("rm -rf", undefined)).toEqual({});
});

test("an unknown flag keeps exact semantics", () => {
  expect(widenArgs("git stash", ["-q"])).toEqual({ argsContains: ["-q"] });
});
