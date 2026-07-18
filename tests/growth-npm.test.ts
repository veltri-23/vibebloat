import { expect, test } from "bun:test";
import { assertPublishable } from "../src/growth/npm-publish";
import { spawnSync } from "node:child_process";

test("publish preflight rejects private and spike packages", () => {
  expect(() => assertPublishable({ private: true, version: "0.0.0-spike" })).toThrow("private");
  expect(() => assertPublishable({ private: false, version: "0.0.0-spike" })).toThrow("spike");
  expect(() => assertPublishable({ private: false, version: "0.1.0" })).not.toThrow();
});

test("publish lifecycle stops spike metadata with a three-line repair", () => {
  const result = spawnSync("bun", ["scripts/prepublish.ts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stderr.trim().split("\n")).toEqual([
    "WHAT failed: npm publish preflight.",
    "WHY: Package is private.",
    "FIX: npm pkg set private=false version=0.1.0",
  ]);
});
