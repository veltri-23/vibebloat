import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installVerifiedGuard } from "../src/library/install";
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
