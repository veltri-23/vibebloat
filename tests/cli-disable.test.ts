import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { disabledGuardIds, disableGuard } from "../src/cli/disable";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("disable persists one guard id for future runtime construction", () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-disable-"));
  tempDirectories.push(home);
  disableGuard("git-stash-untracked", home);
  expect(disabledGuardIds(home)).toEqual(new Set(["git-stash-untracked"]));
});

test("disable command writes the requested guard id", async () => {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-disable-"));
  tempDirectories.push(home);
  const child = Bun.spawn(["bun", "src/cli.ts", "disable", "mcp-config-wrong-file"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, VIBEBLOAT_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect(disabledGuardIds(home)).toEqual(new Set(["mcp-config-wrong-file"]));
});
