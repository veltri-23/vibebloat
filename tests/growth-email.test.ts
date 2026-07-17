import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { forgetEmail, loadEmail, saveEmail } from "../src/growth/email-capture";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("email capture is local and forget removes it", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-email-"));
  tempDirectories.push(directory);
  saveEmail(directory, "person@example.com");
  expect(loadEmail(directory)).toBe("person@example.com");
  forgetEmail(directory);
  expect(loadEmail(directory)).toBeUndefined();
});
