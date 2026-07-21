import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installStarterGuardPack, starterGuardPack } from "../src/install/starter-pack";
import { Runtime } from "../src/runtime";
import { parseGuard } from "../src/schema";

const destructiveCommands = new Map([
  ["starter-git-stash-untracked", "git stash -u"],
  ["starter-rm-recursive-force", "rm -rf /tmp/example"],
  ["starter-git-force-push", "git push -f"],
  ["starter-git-reset-hard", "git reset --hard"],
  // Formerly gated behind a GitHub star; every user gets them now.
  ["starter-git-checkout-discard", "git checkout ."],
  ["starter-git-clean-force", "git clean -fd"],
]);

// Guards whose chokepoint is a file rather than a shell command.
const fileGuards = new Map([["starter-env-file-confirm", ".env"]]);

describe("starter guard pack", () => {
  test("contains only deterministic preventive guards for locked examples", () => {
    const first = starterGuardPack();
    const second = starterGuardPack();

    expect(second).toEqual(first);
    expect(first.map(({ id }) => id)).toEqual([...destructiveCommands.keys(), ...fileGuards.keys()]);
    for (const guard of first) {
      // The .env guard is class B and asks for confirmation rather than
      // warning outright: writing a secret file is not always a mistake.
      // The shell rules are `warn` (not `block`) because the pack is generic
      // cold-start -- a false-positive block would get the whole pack disabled.
      expect(guard.class).toBe(fileGuards.has(guard.id) ? "B" : "A");
      expect(guard.action.type).toBe(fileGuards.has(guard.id) ? "require-confirm" : "warn");
      expect(guard.provenance.source).toBe("vibebloat-starter-pack");
      expect(guard.provenance.incident).toStartWith("Generic cold-start rule for ");
      expect(guard.provenance.incident).toContain("not from your history");
      expect(guard.provenance.incident).not.toContain("deleted");
    }
  });

  test("synthetic locked examples fire and block", () => {
    for (const guard of starterGuardPack()) {
      const event = fileGuards.has(guard.id)
        ? { chokepoint: "file" as const, path: fileGuards.get(guard.id)! }
        : { chokepoint: "shell" as const, command: destructiveCommands.get(guard.id)! };
      expect(new Runtime().evaluate([guard], event)).toMatchObject({ fired: true, guardId: guard.id });
    }
  });

  test("keeps the locked scoped stash true-negative", () => {
    const guard = starterGuardPack().find(({ id }) => id === "starter-git-stash-untracked")!;
    expect(new Runtime().evaluate([guard], {
      chokepoint: "shell",
      command: "git stash -u -- src/cli.ts",
    })).toEqual({ fired: false });
  });

  test("installs atomically without touching unrelated guards", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-starter-pack-"));
    const guardDirectory = join(root, "guards");
    const unrelatedPath = join(guardDirectory, "local-custom.json");
    try {
      mkdirSync(guardDirectory, { recursive: true });
      writeFileSync(unrelatedPath, "local-only\n");

      const report = installStarterGuardPack(guardDirectory);

      expect(report.guardIds).toEqual([...destructiveCommands.keys(), ...fileGuards.keys()]);
      expect(report.writtenPaths).toHaveLength(destructiveCommands.size + fileGuards.size);
      expect(readFileSync(unrelatedPath, "utf8")).toBe("local-only\n");
      for (const guard of starterGuardPack()) {
        const installed = parseGuard(JSON.parse(readFileSync(join(guardDirectory, `${guard.id}.json`), "utf8")));
        expect(installed).toEqual(guard);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("is idempotent", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-starter-pack-"));
    try {
      const first = installStarterGuardPack(join(root, "guards"));
      const before = first.guardIds.map((id) => readFileSync(join(root, "guards", `${id}.json`), "utf8"));
      const second = installStarterGuardPack(join(root, "guards"));

      expect(second.guardIds).toEqual(first.guardIds);
      expect(second.writtenPaths).toEqual([]);
      expect(second.guardIds.map((id) => readFileSync(join(root, "guards", `${id}.json`), "utf8"))).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails before any write when a starter id conflicts with a local guard", () => {
    const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-starter-pack-"));
    const guardDirectory = join(root, "guards");
    const conflictPath = join(guardDirectory, "starter-rm-recursive-force.json");
    try {
      mkdirSync(guardDirectory, { recursive: true });
      writeFileSync(conflictPath, "local collision\n");

      expect(() => installStarterGuardPack(guardDirectory)).toThrow("Starter guard conflicts with existing local guard");
      expect(readFileSync(conflictPath, "utf8")).toBe("local collision\n");
      expect(existsSync(join(guardDirectory, "starter-git-stash-untracked.json"))).toBeFalse();
      expect(existsSync(join(guardDirectory, "starter-git-force-push.json"))).toBeFalse();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
