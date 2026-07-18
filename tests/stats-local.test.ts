import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLocalStats } from "../src/stats/local";

const temporaryDirectories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-stats-"));
  temporaryDirectories.push(value);
  return value;
}

afterEach(() => {
  for (const value of temporaryDirectories.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("aggregates local guard and receipt files without reading their content", () => {
  const first = directory();
  const second = directory();
  writeFileSync(join(first, "guard-one.json"), JSON.stringify({ command: "command-must-not-leave-local-stats" }));
  writeFileSync(join(first, "proof.json"), JSON.stringify({ status: "pass" }));
  writeFileSync(join(second, "guard-two.json"), JSON.stringify({ command: "another-command-must-not-leave-local-stats" }));
  writeFileSync(join(second, "proof.json"), JSON.stringify({ status: "fail" }));
  writeFileSync(join(second, "ignored.txt"), "ignored");
  mkdirSync(join(second, "nested"));

  expect(readLocalStats([first, second, first])).toEqual({ guards: 2, receipts: 2 });
});

test("returns safe zero counts for missing and unreadable directory entries", () => {
  const root = directory();
  const nonDirectory = join(root, "not-a-directory");
  writeFileSync(nonDirectory, "not a directory");

  expect(readLocalStats([join(root, "missing"), nonDirectory])).toEqual({ guards: 0, receipts: 0 });
});
