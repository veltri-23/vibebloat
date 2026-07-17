import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Runtime } from "../src/runtime";
import type { Guard } from "../src/types";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function guard(action: Guard["action"]): Guard {
  return {
    id: "action-test",
    class: "A",
    provenance: { incident: "test", date: "2026-07-17", source: "test" },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action,
    enabled: true,
  };
}

const event = { chokepoint: "shell" as const, command: "git stash -u" };

describe("trusted action library", () => {
  test("block denies a matching action", () => {
    const verdict = new Runtime().evaluate([guard({ type: "block", message: "stop", override: "allow once" })], event);
    expect(verdict).toMatchObject({ fired: true, blocked: true, reason: "stop" });
  });

  test("warn flags but allows a matching action", () => {
    const verdict = new Runtime().evaluate([guard({ type: "warn", message: "careful", override: "allow once" })], event);
    expect(verdict).toMatchObject({ fired: true, blocked: false, warning: "careful" });
  });

  test("require-confirm denies unless an explicit confirmation is supplied", () => {
    const runtime = new Runtime();
    const action = { type: "require-confirm", message: "confirm", override: "allow once" } as const;
    expect(runtime.evaluate([guard(action)], event)).toMatchObject({ blocked: true });
    expect(runtime.evaluate([guard(action)], event, { confirm: () => true })).toMatchObject({ blocked: false });
  });

  test("quarantine-file moves an existing file aside and blocks the write", () => {
    const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-action-"));
    tempDirectories.push(directory);
    const source = join(directory, ".mcp.json");
    const quarantine = join(directory, ".mcp.json.quarantine");
    writeFileSync(source, "{}");

    const quarantineGuard = guard({ type: "quarantine-file", message: "wrong config", override: "allow once", quarantinePath: quarantine });
    quarantineGuard.match = { chokepoint: "file", path: ".mcp.json" };
    const verdict = new Runtime().evaluate([quarantineGuard], { chokepoint: "file", path: source });

    expect(verdict).toMatchObject({ fired: true, blocked: true, quarantinedPath: quarantine });
    expect(existsSync(source)).toBe(false);
    expect(existsSync(quarantine)).toBe(true);
  });

  test("run-check blocks a failing runtime-owned validator", () => {
    const action = { type: "run-check", message: "check failed", override: "allow once", check: "dotenv-newline" } as const;
    const guardWithAction = guard(action);
    expect(new Runtime().evaluate([guardWithAction], event, { checks: { "dotenv-newline": () => false } })).toMatchObject({ blocked: true });
    expect(new Runtime().evaluate([guardWithAction], event, { checks: { "dotenv-newline": () => true } })).toMatchObject({ blocked: false });
  });
});
