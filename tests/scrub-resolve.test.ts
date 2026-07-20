import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScrubbers } from "../src/scrub/resolve";

function emptyRoot(): string {
  return mkdtempSync(join(tmpdir(), "vibebloat-resolve-"));
}

test("falls back to the built-in scrubber when no signed release is present", async () => {
  const resolved = resolveScrubbers({ packageRoot: emptyRoot() });
  expect(resolved.tier).toBe("builtin");
  // The headline promise: a machine with no signed release can still scrub.
  await expect(resolved.presidio("Bearer sk-abcdefghijklmnopqrstuvwxyz012345")).resolves.toContain("<redacted>");
});

test("built-in tier still fails closed when a secret survives", async () => {
  const resolved = resolveScrubbers({ packageRoot: emptyRoot() });
  await expect(resolved.gitleaks("ghp_16C7e42F292c6912E7710c838347Ae178B4a")).resolves.toContain("<redacted");
});

test("prefers the signed release when one verifies", () => {
  const root = emptyRoot();
  mkdirSync(join(root, "release"), { recursive: true });
  writeFileSync(join(root, "release", "metadata.json"), "{}");
  let attempted = false;
  const resolved = resolveScrubbers({
    packageRoot: root,
    resolveControlled: () => {
      attempted = true;
      return { presidio: ["signed", "scrub", "presidio"], gitleaks: ["signed", "scrub", "gitleaks"] };
    },
  });
  expect(attempted).toBe(true);
  expect(resolved.tier).toBe("signed");
});

test("reports the reason the signed tier was unavailable", () => {
  const resolved = resolveScrubbers({
    packageRoot: emptyRoot(),
    resolveControlled: () => { throw new Error("Verified package-controlled scrubber assets are unavailable."); },
  });
  expect(resolved.tier).toBe("builtin");
  expect(resolved.signedUnavailableReason).toContain("unavailable");
});
