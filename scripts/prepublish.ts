import packageJson from "../package.json";
import { assertPublishable } from "../src/growth/npm-publish";

try {
  assertPublishable(packageJson);
} catch (error) {
  process.stderr.write([
    "WHAT failed: npm publish preflight.",
    `WHY: ${error instanceof Error ? error.message : "package metadata is not release-ready."}`,
    "FIX: npm pkg set private=false version=0.1.0",
  ].join("\n") + "\n");
  process.exit(1);
}
