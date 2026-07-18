import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyUpdate } from "../src/updater/auto-update";
import { fingerprintPublicKey } from "../src/doctor/sigstore";

const tempDirectories: string[] = [];
afterEach(() => { for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const publicKey = "controlled test public key";

function metadata() {
  return JSON.stringify({
    schemaVersion: 1,
    version: "0.1.0",
    artifact: "candidate.exe",
    signature: "candidate.exe.sig",
    publicKey: "vibebloat.pub",
    publicKeySha256: fingerprintPublicKey(publicKey),
  });
}

function writeRelease(directory: string, key = publicKey): void {
  writeFileSync(join(directory, "candidate.exe"), "new");
  writeFileSync(join(directory, "vibebloat.pub"), key);
}

test("failed post-update doctor restores prior verified binary", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory);
  expect(() => applyUpdate(binary, directory, metadata(), publicKey, () => 0, () => false)).toThrow("doctor");
  expect(readFileSync(binary, "utf8")).toBe("old");
});

test("verification failure prevents any binary write", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory);

  expect(() => applyUpdate(binary, directory, metadata(), publicKey, () => 1, () => true)).toThrow("Update rejected");
  expect(readFileSync(binary, "utf8")).toBe("old");
});

test("release key file must match pinned key bytes before Cosign runs", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory, "attacker-controlled key");
  let invoked = false;

  expect(() => applyUpdate(binary, directory, metadata(), publicKey, () => { invoked = true; return 0; }, () => true)).toThrow("does not match the pinned key");
  expect(invoked).toBeFalse();
  expect(readFileSync(binary, "utf8")).toBe("old");
});
