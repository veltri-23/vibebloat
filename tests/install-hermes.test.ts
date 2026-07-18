import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installHermesHook } from "../src/install/hermes";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test("Hermes installer copies HookRegistry manifest and handler into supplied hooks directory", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-hermes-"));
  tempDirectories.push(directory);
  const hooksDirectory = join(directory, "hooks");

  expect(() => installHermesHook({ permitted: false, hooksDirectory })).toThrow("permission");
  installHermesHook({ permitted: true, hooksDirectory });

  const hook = join(hooksDirectory, "vibebloat");
  expect(existsSync(join(hook, "HOOK.yaml"))).toBeTrue();
  expect(existsSync(join(hook, "handler.py"))).toBeTrue();
  expect(readFileSync(join(hook, "HOOK.yaml"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../hermes/HOOK.yaml"), "utf8"));
  expect(readFileSync(join(hook, "handler.py"), "utf8")).toBe(readFileSync(join(import.meta.dir, "../hermes/handler.py"), "utf8"));
});
