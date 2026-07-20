import { expect, test } from "bun:test";
import { defaultStarRepository, starRepository } from "../src/growth/star-pack";
import { starterGuardPack } from "../src/install/starter-pack";

test("the star ask points at the project repository", () => {
  expect(starRepository({})).toBe(defaultStarRepository);
  expect(starRepository({ VIBEBLOAT_GITHUB_REPO: "someone/fork" })).toBe("someone/fork");
});

test("a malformed repository slug is rejected rather than used in a URL", () => {
  expect(() => starRepository({ VIBEBLOAT_GITHUB_REPO: "not a repo" })).toThrow();
  expect(() => starRepository({ VIBEBLOAT_GITHUB_REPO: "https://evil.test/x" })).toThrow();
});

test("no guard is withheld pending a star", () => {
  // These three were previously locked behind starring the repo.
  const ids = starterGuardPack().map(({ id }) => id);
  expect(ids).toContain("starter-git-checkout-discard");
  expect(ids).toContain("starter-git-clean-force");
  expect(ids).toContain("starter-env-file-confirm");
  expect(ids.some((id) => id.startsWith("star-"))).toBe(false);
});
