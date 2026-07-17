import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRollback, rollback } from "../src/updater/rollback";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("rollback restores prior binary content", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  const backup = createRollback(binary);
  writeFileSync(binary, "new");
  rollback(binary, backup);
  expect(readFileSync(binary, "utf8")).toBe("old");
});
