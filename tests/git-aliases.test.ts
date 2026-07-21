import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitStashUntrackedGuard } from "../src/guards";
import { readGitAliases, withGitAliases } from "../src/normalization/git-aliases";
import { Runtime } from "../src/runtime";

const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-git-alias-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

test("local repository aliases override global aliases before runtime evaluation", () => {
  const root = directory();
  const home = join(root, "home");
  const repository = join(root, "repository");
  mkdirSync(join(repository, ".git"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "[alias]\n  st = status\n");
  writeFileSync(join(repository, ".git", "config"), "[alias]\n  st = stash --include-untracked\n");
  const options = { cwd: repository, environment: { HOME: home } as NodeJS.ProcessEnv };

  expect(readGitAliases(options)).toEqual({ st: "stash --include-untracked" });
  const runtime = new Runtime([], undefined, (event) => withGitAliases(event, options));
  expect(runtime.evaluate([gitStashUntrackedGuard], { chokepoint: "shell", command: "git st", hasUnstagedChanges: true })).toMatchObject({ fired: true, blocked: true });
});

test("unsafe shell aliases fail closed for Class A and do not leak into events", () => {
  const event = withGitAliases(
    { chokepoint: "shell", command: "git st -u", hasUnstagedChanges: true },
    { cwd: directory(), environment: { HOME: directory() } },
  );
  const runtime = new Runtime([], undefined, () => ({ ...event, aliases: { st: "!git stash -u" } }));

  expect(runtime.evaluate([gitStashUntrackedGuard], event)).toMatchObject({ fired: true, parseError: true });
  expect(event).not.toHaveProperty("command", "!git stash -u");
});

test("unreadable Git alias configuration fails closed for Class A", () => {
  const root = directory();
  const home = join(root, "home");
  mkdirSync(home);
  writeFileSync(join(home, ".gitconfig"), "x".repeat(256 * 1024 + 1));
  const event = withGitAliases(
    { chokepoint: "shell", command: "git st -u", hasUnstagedChanges: true },
    { cwd: root, environment: { HOME: home } },
  );

  expect(event.aliasResolutionFailed).toBeTrue();
  expect(new Runtime().evaluate([gitStashUntrackedGuard], event)).toMatchObject({ fired: true, parseError: true });
});
