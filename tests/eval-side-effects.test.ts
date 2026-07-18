import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Guard } from "../src/types";

function runEval(guard: Guard, event: { chokepoint: "file"; path: string }) {
  return Bun.spawnSync(["bun", "src/cli.ts", "eval"], {
    cwd: import.meta.dir + "/..",
    stdin: new TextEncoder().encode(JSON.stringify({ guard, event })),
  });
}

test("eval returns fired verdicts without dispatching quarantine or checks", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-eval-"));
  try {
    const source = join(directory, "danger.env");
    const quarantinePath = join(directory, "quarantined.env");
    writeFileSync(source, "keep me");

    const quarantineGuard: Guard = {
      id: "quarantine-eval-proof",
      class: "B",
      provenance: { incident: "synthetic file proof", date: "2026-07-18", source: "test" },
      match: { chokepoint: "file", path: "danger.env" },
      action: {
        type: "quarantine-file",
        message: "Would quarantine outside eval.",
        override: "vibebloat allow quarantine-eval-proof --once",
        quarantinePath,
      },
      enabled: true,
    };
    const quarantineResult = runEval(quarantineGuard, { chokepoint: "file", path: source });
    expect(quarantineResult.exitCode).toBe(0);
    expect(JSON.parse(quarantineResult.stdout.toString())).toEqual({
      fired: true,
      guardId: "quarantine-eval-proof",
      reason: "Would quarantine outside eval.",
    });
    expect(existsSync(source)).toBeTrue();
    expect(existsSync(quarantinePath)).toBeFalse();

    const runCheckGuard: Guard = {
      ...quarantineGuard,
      id: "run-check-eval-proof",
      action: {
        type: "run-check",
        message: "Would run a check outside eval.",
        override: "vibebloat allow run-check-eval-proof --once",
        check: "synthetic-check",
      },
    };
    const checkResult = runEval(runCheckGuard, { chokepoint: "file", path: source });
    expect(checkResult.exitCode).toBe(0);
    expect(JSON.parse(checkResult.stdout.toString())).toEqual({
      fired: true,
      guardId: "run-check-eval-proof",
      reason: "Would run a check outside eval.",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
