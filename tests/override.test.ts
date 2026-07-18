import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allowOnce, consumeAllowedOnce } from "../src/runtime/override";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function home(): string {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-override-"));
  tempDirectories.push(directory);
  return directory;
}

test("persisted override has one atomic claimant", () => {
  const directory = home();
  allowOnce("no-publish", directory);
  expect(() => allowOnce("no-publish", directory)).toThrow("already pending");
  expect(consumeAllowedOnce("no-publish", directory)).toBeTrue();
  expect(consumeAllowedOnce("no-publish", directory)).toBeFalse();
});

test("malformed persisted override fails closed", () => {
  const directory = home();
  allowOnce("no-publish", directory);
  const state = join(directory, "overrides");
  const entries = readdirSync(state);
  writeFileSync(join(state, entries[0]), "{");
  expect(() => consumeAllowedOnce("no-publish", directory)).toThrow("Override state is invalid.");
  expect(existsSync(join(state, entries[0]))).toBeFalse();
});
