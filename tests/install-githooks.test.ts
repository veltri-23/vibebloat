import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installGitHook } from "../src/install/git-hooks";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("git hook install appends once without replacing an existing hook", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-git-"));
  tempDirectories.push(directory);
  const hookPath = join(directory, "pre-commit");
  writeFileSync(hookPath, "#!/bin/sh\necho existing\n");

  installGitHook(hookPath, "bun vibebloat hook");
  installGitHook(hookPath, "bun vibebloat hook");

  expect(readFileSync(hookPath, "utf8")).toBe("#!/bin/sh\necho existing\n# vibebloat:start\nbun vibebloat hook\n# vibebloat:end\n");
});
