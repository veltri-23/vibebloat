import { expect, test } from "bun:test";
import { gitHookCommandLine } from "../src/install/git-hooks";

test("hook command invokes this executable, not a bare name on PATH", () => {
  const line = gitHookCommandLine("pre-commit", ["/usr/bin/bun", "/opt/vibebloat/src/cli.ts"]);
  expect(line).toBe('/usr/bin/bun /opt/vibebloat/src/cli.ts git-hook pre-commit');
  // A bare `vibebloat` breaks every commit in the repo when the binary is not
  // installed globally, which is the default until npm publish lands.
  expect(line.startsWith("vibebloat ")).toBe(false);
});

test("quotes paths with spaces and uses sh-safe forward slashes", () => {
  const line = gitHookCommandLine("pre-push", ["C:\\Program Files\\bun\\bun.exe", "D:\\my repo\\src\\cli.ts"]);
  // Hooks run under /bin/sh even on Windows, where a backslash escapes.
  expect(line).toBe('"C:/Program Files/bun/bun.exe" "D:/my repo/src/cli.ts" git-hook pre-push');
  expect(line).not.toContain("\\");
});

test("supports a standalone binary with no script argument", () => {
  expect(gitHookCommandLine("pre-commit", ["/usr/local/bin/vibebloat"])).toBe("/usr/local/bin/vibebloat git-hook pre-commit");
});

test("stays a single line so the hook block cannot be corrupted", () => {
  expect(gitHookCommandLine("pre-commit", ["/usr/bin/bun", "/opt/cli.ts"])).not.toContain("\n");
});
