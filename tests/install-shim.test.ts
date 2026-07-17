import { expect, test } from "bun:test";
import { shellPathProbe, verifyShellPaths } from "../src/install/shim";

const shimDirectory = "C:/tools/vibebloat";

test("PATH probe is defined for bash, zsh, fish, and pwsh", () => {
  for (const shell of ["bash", "zsh", "fish", "pwsh"] as const) {
    expect(shellPathProbe(shell, shimDirectory)).toContain(shell === "pwsh" ? shimDirectory : "/c/tools/vibebloat");
  }
});

test("install verification requires shim first in every configured shell", () => {
  verifyShellPaths(shimDirectory, (shell) => shell === "pwsh"
    ? `${shimDirectory};C:/Windows/System32`
    : `/c/tools/vibebloat:/usr/bin`);
});

test("install verification fails when a shell prepends another PATH entry", () => {
  expect(() => verifyShellPaths(shimDirectory, (shell) => shell === "fish"
    ? "/usr/local/bin:/c/tools/vibebloat"
    : shell === "pwsh"
      ? `${shimDirectory};C:/Windows/System32`
      : "/c/tools/vibebloat:/usr/bin")).toThrow("fish");
});
