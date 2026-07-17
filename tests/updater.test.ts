import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyUpdate } from "../src/updater/auto-update";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("failed post-update doctor restores prior binary", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  expect(() => applyUpdate(binary, "new", () => false)).toThrow("doctor");
  expect(readFileSync(binary, "utf8")).toBe("old");
});
