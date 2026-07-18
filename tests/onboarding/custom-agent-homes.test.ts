import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCustomAgentHomes, saveCustomAgentHome } from "../../src/onboarding/custom-agent-homes";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("custom agent homes persist atomically and reject tampered receipts", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-custom-home-"));
  const state = join(root, "state");
  const codex = join(root, "codex");
  roots.push(root);
  mkdirSync(codex, { recursive: true });

  expect(saveCustomAgentHome(state, "codex", codex)).toEqual({ codex });
  expect(readCustomAgentHomes(state)).toEqual({ codex });

  writeFileSync(join(state, "custom-agent-homes.json"), JSON.stringify({ schemaVersion: 1, owner: "vibebloat", homes: { unknown: codex } }));
  expect(() => readCustomAgentHomes(state)).toThrow("invalid");
});
