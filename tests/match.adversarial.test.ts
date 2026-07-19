import { describe, expect, test } from "bun:test";
import { gitStashUntrackedGuard } from "../src/guards";
import { match } from "../src/match";
import { Runtime } from "../src/runtime";
import type { Guard } from "../src/types";

const guard = gitStashUntrackedGuard;

function shellVerdict(command: string) {
  return match(guard, { chokepoint: "shell", command });
}

describe("comment handling", () => {
  test("apostrophe inside a trailing comment is not a parse error", () => {
    expect(shellVerdict("echo hello # it's ok")).toMatchObject({ fired: false });
    expect(shellVerdict("npm run build # don't cache")).toMatchObject({ fired: false });
    expect(shellVerdict("git stash # let's keep this")).toMatchObject({ fired: false });
  });

  test("hash inside quotes is not a comment", () => {
    expect(shellVerdict("git stash -u 'notes # keep'")).toMatchObject({ fired: true });
  });

  test("genuinely unterminated quote still fails closed for Class A", () => {
    expect(shellVerdict("echo 'unterminated")).toMatchObject({ fired: true, parseError: true });
  });
});

describe("git global options", () => {
  test("-C and -c no longer bypass the subcommand check", () => {
    expect(shellVerdict("git -C /some/repo stash -u")).toMatchObject({ fired: true });
    expect(shellVerdict("git -c core.pager=cat stash -u")).toMatchObject({ fired: true });
    expect(shellVerdict("git --git-dir=/tmp/x stash -u")).toMatchObject({ fired: true });
  });

  test("global options on a safe subcommand stay quiet", () => {
    expect(shellVerdict("git -C /some/repo status")).toMatchObject({ fired: false });
  });
});

describe("bundled short flags", () => {
  test("bundled -ua and -au still match -u", () => {
    expect(shellVerdict("git stash -ua")).toMatchObject({ fired: true });
    expect(shellVerdict("git stash -au")).toMatchObject({ fired: true });
  });

  test("unrelated short flags stay quiet", () => {
    expect(shellVerdict("git stash -q")).toMatchObject({ fired: false });
  });
});

describe("double-dash scoping", () => {
  test("git pathspec scoping stays a true negative", () => {
    expect(shellVerdict("git stash -u -- src/file.ts")).toMatchObject({ fired: false });
  });

  test("trailing -- without a pathspec no longer bypasses", () => {
    expect(shellVerdict("git stash -u --")).toMatchObject({ fired: true });
  });

  test("-- on non-git commands no longer bypasses", () => {
    const rmGuard: Guard = {
      id: "rm-recursive-force",
      class: "A",
      provenance: { incident: "test", date: "2026-07-18", source: "test" },
      match: { chokepoint: "shell", command: "rm -rf" },
      action: { type: "block", message: "blocked", override: "vibebloat allow rm-recursive-force --once" },
      enabled: true,
    };
    expect(match(rmGuard, { chokepoint: "shell", command: "rm -rf -- /important/data" })).toMatchObject({ fired: true });
  });
});

describe("windows binaries", () => {
  test("git.exe matches the git guard", () => {
    expect(shellVerdict("git.exe stash -u")).toMatchObject({ fired: true });
  });
});

describe("override scope", () => {
  test("an override for one guard does not skip later guards", () => {
    const otherGuard: Guard = {
      id: "git-stash-quiet",
      class: "A",
      provenance: { incident: "test", date: "2026-07-18", source: "test" },
      match: { chokepoint: "shell", command: "git stash", argsContains: ["-u"] },
      action: { type: "block", message: "second guard", override: "vibebloat allow git-stash-quiet --once" },
      enabled: true,
    };
    const runtime = new Runtime();
    runtime.allowOnce(guard.id);
    const verdict = runtime.evaluate([guard, otherGuard], { chokepoint: "shell", command: "git stash -u" });
    expect(verdict).toMatchObject({ fired: true, guardId: "git-stash-quiet" });
  });
});
