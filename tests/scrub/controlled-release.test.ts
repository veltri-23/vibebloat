import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ControlledScrubbersUnavailableError, resolveControlledScrubberCommands } from "../../src/scrub/controlled-release";

test("controlled scrubbers reject metadata that supplies its own key pin", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-controlled-release-"));
  try {
    mkdirSync(join(directory, "release"));
    writeFileSync(join(directory, "release", "metadata.json"), JSON.stringify({
      schemaVersion: 1,
      version: "0.1.0",
      artifact: "release/scrubber.exe",
      signature: "release/scrubber.sig",
      publicKey: "release/scrubber.pub",
      publicKeySha256: "a".repeat(64),
    }));
    expect(() => resolveControlledScrubberCommands(directory)).toThrow(ControlledScrubbersUnavailableError);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
