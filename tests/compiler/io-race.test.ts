import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { guardWatchPath, replaceGuardAtomically } from "../../src/compiler/live-compile";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("atomic guard replacement never exposes a partial guard file", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-guard-io-"));
  tempDirectories.push(directory);
  const path = join(directory, "guard.json");
  writeFileSync(path, '{"version":1}');

  replaceGuardAtomically(path, '{"version":2,"complete":true}');

  expect(readFileSync(path, "utf8")).toBe('{"version":2,"complete":true}');
  expect(existsSync(`${path}.tmp`)).toBe(false);
});

test("guard watcher ignores temporary files and reports final JSON renames", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-guard-watch-"));
  tempDirectories.push(directory);

  expect(guardWatchPath(directory, ".partial.tmp")).toBeUndefined();
  expect(guardWatchPath(directory, "guard.json")).toBe(join(directory, "guard.json"));
});
