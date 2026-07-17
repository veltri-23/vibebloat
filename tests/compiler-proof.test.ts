import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeProof } from "../src/compiler/proof";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("proof runner writes a machine-owned outcome marker", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-proof-"));
  tempDirectories.push(directory);
  writeProof(directory, { status: "pass", cases: ["blocks git stash -u"] });
  expect(JSON.parse(readFileSync(join(directory, "proof.json"), "utf8"))).toEqual({ status: "pass", cases: ["blocks git stash -u"] });
});
