import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  engines?: { bun?: string };
  files?: string[];
};

test("npm package allowlists runtime files and requires Bun", () => {
  expect(packageJson.files).toEqual(["bin", "src", "LICENSE", "NOTICE", "README.md"]);
  expect(packageJson.engines?.bun).toBe(">=1.3.0");
});
