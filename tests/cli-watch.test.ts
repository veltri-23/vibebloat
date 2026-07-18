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

test("watch fails closed when a file guard needs pre-write enforcement", () => {
  const result = Bun.spawnSync(["bun", "src/cli.ts", "watch", import.meta.dir], {
    cwd: import.meta.dir + "/..",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("WHAT failed: filesystem watch could not start.\nWHY: fs.watch observes writes after they occur and cannot enforce active file guards\nFIX: vibebloat watch <directory>\n");
});
