import { expect, test } from "bun:test";

test("watch requires a directory", () => {
  const result = Bun.spawnSync(["bun", "src/cli.ts", "watch"], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("WHAT failed: watch directory was not supplied.\nWHY: watch needs one directory path.\nFIX: vibebloat watch <directory>\n");
});
