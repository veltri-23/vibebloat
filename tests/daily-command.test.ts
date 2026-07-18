import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatDailyStrengtheningFailure, runDailyStrengtheningCommand } from "../src/cli/daily";
import type { Guard } from "../src/types";

const roots: string[] = [];
const now = new Date("2026-07-18T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-daily-command-"));
  roots.push(root);
  return root;
}

function guard(): Guard {
  return {
    schemaVersion: 1,
    id: "stale-guard",
    class: "A",
    provenance: { incident: "Bearer private-secret at C:\\private\\source.ts", date: "2026-04-18", source: "local" },
    match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
    action: { type: "block", message: "Use scoped stash.", override: "vibebloat allow stale-guard --once" },
    confidence: "high",
    binds: [],
    enabled: true,
  };
}

test("daily command atomically writes deterministic proposals without installing guards", () => {
  const root = temporaryRoot();
  const home = join(root, "local-home");
  const user = join(root, "user");
  const guards = join(home, "guards");
  mkdirSync(guards, { recursive: true });
  mkdirSync(join(user, ".vibebloat", "audit", "last-fired"), { recursive: true });
  writeFileSync(join(home, "profile.md"), "Local profile\n");
  writeFileSync(join(guards, "proof.json"), "{}\n");
  const guardPath = join(guards, "stale-guard.json");
  writeFileSync(guardPath, `${JSON.stringify(guard())}\n`);
  const old = new Date("2026-04-18T12:00:00.000Z");
  utimesSync(guardPath, old, old);
  const before = readFileSync(guardPath, "utf8");
  const environment = { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: user, HOME: user };

  const first = runDailyStrengtheningCommand({ scope: "machine", environment, cwd: root, now });
  const firstBytes = readFileSync(first.proposalPath, "utf8");
  const second = runDailyStrengtheningCommand({ scope: "machine", environment, cwd: root, now });

  expect(second.report.proposals).toEqual([
    { type: "reaffirm-guard", guardId: "stale-guard", reason: "no-fire-in-90-days" },
  ]);
  expect(readFileSync(second.proposalPath, "utf8")).toBe(firstBytes);
  expect(readFileSync(guardPath, "utf8")).toBe(before);
  expect(firstBytes).not.toContain("private-secret");
  expect(firstBytes).not.toContain("source.ts");
  expect(firstBytes).not.toContain(root);
  expect(existsSync(join(guards, "new-guard.json"))).toBeFalse();
});

test("daily command proposes restoration from audit metadata only", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const user = join(root, "user");
  const audit = join(user, ".vibebloat", "audit", "last-fired");
  mkdirSync(join(home, "guards"), { recursive: true });
  mkdirSync(audit, { recursive: true });
  writeFileSync(join(home, "profile.md"), "Local profile\n");
  writeFileSync(join(audit, "missing-guard.json"), `${JSON.stringify({ schemaVersion: 1, guardId: "missing-guard", lastFiredAt: "2026-07-17T12:00:00.000Z" })}\n`);

  const result = runDailyStrengtheningCommand({
    environment: { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: user, HOME: user },
    cwd: root,
    now,
  });

  expect(result.report.proposals).toEqual([
    { type: "restore-guard", guardId: "missing-guard", reason: "audit-without-guard" },
  ]);
  expect(readFileSync(result.proposalPath, "utf8")).not.toContain(audit);
  expect(existsSync(join(home, "guards", "missing-guard.json"))).toBeFalse();
});

test("daily command rejects a redirected proposal directory and exposes a fixed repair", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const outside = join(root, "outside");
  mkdirSync(join(home, "guards"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(home, "daily"), process.platform === "win32" ? "junction" : "dir");

  expect(() => runDailyStrengtheningCommand({
    environment: { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: root, HOME: root },
    cwd: root,
    now,
  })).toThrow("Daily path is unsafe.");
  expect(existsSync(join(outside, "proposals.json"))).toBeFalse();
  expect(formatDailyStrengtheningFailure()).toBe(
    "WHAT failed: daily strengthening stopped.\n" +
    "WHY: installed guards, audit evidence, or proposal storage was unsafe or unreadable.\n" +
    "FIX: vibebloat doctor\n",
  );
});

test("daily command rejects redirected guard reads before writing proposals", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  const outside = join(root, "outside-guards");
  mkdirSync(home);
  mkdirSync(outside);
  writeFileSync(join(outside, "outside.json"), `${JSON.stringify(guard())}\n`);
  symlinkSync(outside, join(home, "guards"), process.platform === "win32" ? "junction" : "dir");

  expect(() => runDailyStrengtheningCommand({
    environment: { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: root, HOME: root },
    cwd: root,
    now,
  })).toThrow("Daily path is unsafe.");
  expect(existsSync(join(home, "daily", "proposals.json"))).toBeFalse();
});

test("daily CLI emits only local safe report metadata", () => {
  const root = temporaryRoot();
  const home = join(root, "home");
  mkdirSync(join(home, "guards"), { recursive: true });
  writeFileSync(join(home, "guards", "proof.json"), "{}\n");

  const result = Bun.spawnSync(["bun", "src/cli.ts", "daily"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, VIBEBLOAT_HOME: home, USERPROFILE: root, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as Record<string, unknown>;
  expect(report.schemaVersion).toBe(1);
  expect(report.scope).toBe("machine");
  expect(report).not.toHaveProperty("proposalPath");
  expect(result.stdout.toString()).not.toContain(root);
  expect(result.stderr.toString()).toBe("");
  expect(existsSync(join(home, "daily", "proposals.json"))).toBeTrue();
});
