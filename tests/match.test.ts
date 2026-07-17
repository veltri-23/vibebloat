import { describe, expect, test } from "bun:test";
import { gitStashUntrackedGuard, mcpConfigWrongFileGuard } from "../src/guards";
import { match } from "../src/match";
import { Runtime } from "../src/runtime";

describe("Phase 0 matcher", () => {
  test("eval fires for a synthetic destructive event", () => {
    expect(match(gitStashUntrackedGuard, { chokepoint: "shell", command: "git stash -u" })).toMatchObject({ fired: true });
  });

  test("eval CLI replays a synthetic event", () => {
    const result = Bun.spawnSync(["bun", "src/cli.ts", "eval"], {
      cwd: import.meta.dir + "/..",
      stdin: Bun.file(import.meta.dir + "/fixtures/spike-event.json"),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({ fired: true });
  });

  test("normalizes an absolute git path", () => {
    expect(match(gitStashUntrackedGuard, { chokepoint: "shell", command: "/usr/bin/git stash -u" })).toMatchObject({ fired: true });
  });

  test("expands environment variables before evaluation", () => {
    expect(match(gitStashUntrackedGuard, {
      chokepoint: "shell",
      command: "$GIT_BIN stash -u",
      variables: { GIT_BIN: "/usr/bin/git" },
    })).toMatchObject({ fired: true });
  });

  test("resolves git aliases before evaluation", () => {
    expect(match(gitStashUntrackedGuard, {
      chokepoint: "shell",
      command: "git config alias.st stash && git st -u",
      aliases: { st: "stash" },
    })).toMatchObject({ fired: true });
  });

  test("fails closed on a Class A parse error and open for Class B, C, and D", () => {
    const malformed = { chokepoint: "shell" as const, command: "git stash -u '" };
    expect(match(gitStashUntrackedGuard, malformed)).toMatchObject({ fired: true, parseError: true });
    for (const guardClass of ["B", "C", "D"] as const) {
      expect(match({ ...gitStashUntrackedGuard, class: guardClass }, malformed)).toMatchObject({ fired: false, parseError: true });
    }
  });

  test("fails closed for Class A syntax errors before the keyword fast path", () => {
    expect(match(gitStashUntrackedGuard, { chokepoint: "shell", command: "echo 'unterminated" })).toMatchObject({ fired: true, parseError: true });
  });

  test("allows exactly one override", () => {
    const runtime = new Runtime();
    runtime.allowOnce(gitStashUntrackedGuard.id);
    expect(runtime.evaluate([gitStashUntrackedGuard], { chokepoint: "shell", command: "git stash -u" }).fired).toBeFalse();
    expect(runtime.evaluate([gitStashUntrackedGuard], { chokepoint: "shell", command: "git stash -u" }).fired).toBeTrue();
  });

  test("blocks Class B wrong-file writes", () => {
    expect(match(mcpConfigWrongFileGuard, { chokepoint: "file", path: "C:\\repo\\.mcp.json" })).toMatchObject({ fired: true });
  });
});
