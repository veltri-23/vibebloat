import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimStarPack, starGuardPack, starRepository, verifyGitHubStar } from "../src/growth/star-pack";
import { Runtime } from "../src/runtime";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function guardDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "vibebloat-star-pack-"));
  temporaryDirectories.push(directory);
  return join(directory, "guards");
}

function stargazerFetch(logins: string[][], status = 200): typeof fetch {
  return (async (url: string | URL | Request) => {
    const page = Number(new URL(String(url)).searchParams.get("page"));
    if (status !== 200) return new Response("[]", { status });
    return Response.json(logins[page - 1]?.map((login) => ({ login })) ?? []);
  }) as typeof fetch;
}

describe("star guard pack", () => {
  test("contains exactly three deterministic preventive guards", () => {
    const pack = starGuardPack();
    expect(pack.map(({ id }) => id)).toEqual([
      "star-git-checkout-discard",
      "star-git-clean-force",
      "star-env-file-confirm",
    ]);
    expect(starGuardPack()).toEqual(pack);
    for (const guard of pack) expect(guard.provenance.source).toBe("vibebloat-star-pack");
  });

  test("synthetic positives fire and block", () => {
    const pack = starGuardPack();
    const runtime = new Runtime();
    expect(runtime.evaluate(pack, { chokepoint: "shell", command: "git checkout ." })).toMatchObject({ fired: true, blocked: true, guardId: "star-git-checkout-discard" });
    expect(runtime.evaluate(pack, { chokepoint: "shell", command: "git clean -fd" })).toMatchObject({ fired: true, blocked: true, guardId: "star-git-clean-force" });
    expect(runtime.evaluate(pack, { chokepoint: "file", path: "project/.env" })).toMatchObject({ fired: true, blocked: true, guardId: "star-env-file-confirm" });
  });

  test("true negatives stay quiet", () => {
    const pack = starGuardPack();
    const runtime = new Runtime();
    expect(runtime.evaluate(pack, { chokepoint: "shell", command: "git checkout -- ." })).toMatchObject({ fired: false });
    expect(runtime.evaluate(pack, { chokepoint: "shell", command: "git checkout feature-branch" })).toMatchObject({ fired: false });
    expect(runtime.evaluate(pack, { chokepoint: "shell", command: "git clean -n" })).toMatchObject({ fired: false });
    expect(runtime.evaluate(pack, { chokepoint: "file", path: "project/example.env" })).toMatchObject({ fired: false });
  });
});

describe("verifyGitHubStar", () => {
  test("finds a star across pages, case-insensitively", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => `user-${index}`);
    await expect(verifyGitHubStar("Hunter-Dev", {
      repository: "veltri-23/vibebloat",
      fetch: stargazerFetch([fullPage, ["someone", "hunter-dev"]]),
    })).resolves.toBe(true);
  });

  test("returns false without retrying when the star is absent", async () => {
    await expect(verifyGitHubStar("missing-user", {
      repository: "veltri-23/vibebloat",
      fetch: stargazerFetch([["someone-else"]]),
      attempts: 1,
    })).resolves.toBe(false);
  });

  test("throws on API failure and invalid username", async () => {
    await expect(verifyGitHubStar("hunter", {
      repository: "veltri-23/vibebloat",
      fetch: stargazerFetch([], 500),
      attempts: 1,
    })).rejects.toThrow("status 500");
    await expect(verifyGitHubStar("-bad-", { fetch: stargazerFetch([[]]) })).rejects.toThrow("Invalid GitHub username");
  });

  test("rejects an invalid repository slug from the environment", () => {
    expect(() => starRepository({ VIBEBLOAT_GITHUB_REPO: "not a slug" })).toThrow("Invalid GitHub repository slug");
  });
});

describe("claimStarPack", () => {
  test("verifies then installs the three guards", async () => {
    const directory = guardDirectory();
    const report = await claimStarPack("hunter", directory, {
      repository: "veltri-23/vibebloat",
      fetch: stargazerFetch([["hunter"]]),
    });
    expect(report).toMatchObject({ repository: "veltri-23/vibebloat", username: "hunter" });
    expect(report.guardIds).toHaveLength(3);
    for (const path of report.writtenPaths) {
      expect(existsSync(path)).toBeTrue();
      expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    }
  });

  test("refuses to install without a verified star", async () => {
    const directory = guardDirectory();
    await expect(claimStarPack("hunter", directory, {
      repository: "veltri-23/vibebloat",
      fetch: stargazerFetch([["someone-else"]]),
      attempts: 1,
    })).rejects.toThrow("No star from hunter");
    expect(existsSync(directory)).toBeFalse();
  });
});
