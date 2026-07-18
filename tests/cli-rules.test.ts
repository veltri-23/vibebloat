import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { summarizeRules } from "../src/cli/rules";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";

test("rule summaries expose management metadata without incident content", () => {
  const summaries = summarizeRules([mcpConfigWrongFileGuard, gitStashUntrackedGuard]);

  expect(summaries.map(({ id }) => id)).toEqual(["git-stash-u", "mcp-config-wrong-file"]);
  expect(summaries[0]).toEqual({
    action: "block",
    binds: [],
    class: "A",
    confidence: null,
    enabled: true,
    id: "git-stash-u",
    tier: null,
  });
  const output = JSON.stringify(summaries);
  expect(output).not.toContain("incident");
  expect(output).not.toContain("message");
  expect(output).not.toContain("path");
});

test("rule summaries report effective persisted disable state", () => {
  const [summary] = summarizeRules([gitStashUntrackedGuard], ["git-stash-untracked"]);
  expect(summary.enabled).toBeFalse();
});

test("rules CLI emits sorted safe metadata and fails closed on invalid guards", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-rules-cli-"));
  const home = join(root, "home");
  const guards = join(home, "guards");
  mkdirSync(guards, { recursive: true });
  writeFileSync(join(home, "disabled.json"), "[\"git-stash-untracked\"]\n");
  writeFileSync(join(guards, "zeta.json"), `${JSON.stringify({
    schemaVersion: 1,
    id: "zeta-rule",
    class: "A",
    provenance: { incident: "private incident", date: "2026-07-18", source: "local" },
    match: { chokepoint: "shell", command: "git push" },
    action: { type: "warn", message: "private message", override: "vibebloat allow zeta-rule --once" },
    binds: ["hermes", "claude-code"],
    enabled: true,
  })}\n`);
  const environment = { ...process.env, VIBEBLOAT_HOME: home };

  try {
    const result = Bun.spawnSync(["bun", "src/cli.ts", "rules"], { cwd: join(import.meta.dir, ".."), env: environment, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    const summaries = JSON.parse(result.stdout.toString()) as Array<Record<string, unknown>>;
    expect(summaries.map(({ id }) => id)).toEqual(["git-stash-u", "mcp-config-wrong-file", "zeta-rule"]);
    expect(summaries.find(({ id }) => id === "git-stash-u")?.enabled).toBeFalse();
    expect(summaries.find(({ id }) => id === "zeta-rule")?.binds).toEqual(["claude-code", "hermes"]);
    expect(result.stdout.toString()).not.toContain("private incident");
    expect(result.stdout.toString()).not.toContain("private message");
    expect(result.stderr.toString()).toBe("");

    writeFileSync(join(guards, "broken.json"), "not-json\n");
    const failed = Bun.spawnSync(["bun", "src/cli.ts", "rules"], { cwd: join(import.meta.dir, ".."), env: environment, stdout: "pipe", stderr: "pipe" });
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout.toString()).toBe("");
    expect(failed.stderr.toString()).toBe("WHAT failed: rule listing stopped.\nWHY: guard runtime could not load or evaluate installed guards.\nFIX: vibebloat doctor\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
