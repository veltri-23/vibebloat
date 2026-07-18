import packageJson from "../package.json";
import { assertPublishable } from "../src/growth/npm-publish";

try {
  assertPublishable(packageJson);
} catch (error) {
  const fix = packageJson.private
    ? "npm pkg set private=false --json"
    : "npm version 0.1.0 --no-git-tag-version";
  process.stderr.write([
    "WHAT failed: npm publish preflight.",
    `WHY: ${error instanceof Error ? error.message : "package metadata is not release-ready."}`,
    `FIX: ${fix}`,
  ].join("\n") + "\n");
  process.exit(1);
}
