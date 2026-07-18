import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function rollbackPaths(directory: string): string[] {
  return readdirSync(directory).filter((path) => path.endsWith(".rollback"));
}

test("verification precedes writes and successful doctor removes rollback", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory);
  const order: string[] = [];

  applyUpdate(binary, directory, metadata(), publicKey, () => {
    order.push("verify");
    expect(readFileSync(binary, "utf8")).toBe("old");
    expect(rollbackPaths(directory)).toEqual([]);
    return 0;
  }, () => {
    order.push("doctor");
    expect(readFileSync(binary, "utf8")).toBe("new");
    expect(rollbackPaths(directory)).toHaveLength(1);
    expect(readdirSync(directory).some((path) => path.endsWith(".update"))).toBeFalse();
    return true;
  });

  expect(order).toEqual(["verify", "doctor"]);
  expect(readFileSync(binary, "utf8")).toBe("new");
  expect(rollbackPaths(directory)).toEqual([]);
});

test("failed candidate doctor restores prior binary and rechecks it", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory);
  let doctorCalls = 0;

  expect(() => applyUpdate(binary, directory, metadata(), publicKey, () => 0, () => ++doctorCalls === 2)).toThrow("candidate doctor failed");
  expect(readFileSync(binary, "utf8")).toBe("old");
  expect(doctorCalls).toBe(2);
  const backups = rollbackPaths(directory);
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(directory, backups[0]), "utf8")).toBe("old");
});

test("failed restored doctor reports rollback health and preserves backup", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory);
  let doctorCalls = 0;

  expect(() => applyUpdate(binary, directory, metadata(), publicKey, () => 0, () => { doctorCalls += 1; return false; })).toThrow("rollback health check failed");
  expect(readFileSync(binary, "utf8")).toBe("old");
  expect(doctorCalls).toBe(2);
  const backups = rollbackPaths(directory);
  expect(backups).toHaveLength(1);
  expect(readFileSync(join(directory, backups[0]), "utf8")).toBe("old");
});

test("verification failure prevents any binary write", () => {
  const directory = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-update-"));
  tempDirectories.push(directory);
  const binary = join(directory, "vibebloat.exe");
  writeFileSync(binary, "old");
  writeRelease(directory);

  expect(() => applyUpdate(binary, directory, metadata(), publicKey, () => 1, () => true)).toThrow("Update rejected");
  expect(readFileSync(binary, "utf8")).toBe("old");
  expect(rollbackPaths(directory)).toEqual([]);
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
  expect(rollbackPaths(directory)).toEqual([]);
});
