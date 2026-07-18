import { expect, test } from "bun:test";
import { fingerprintPublicKey, parseReleaseMetadata, verifySigstore } from "../src/doctor/sigstore";

const publicKey = "-----BEGIN PUBLIC KEY-----\ncontrolled-test-key\n-----END PUBLIC KEY-----\n";
const metadata = parseReleaseMetadata(JSON.stringify({
  schemaVersion: 1,
  version: "0.1.0",
  artifact: "dist/vibebloat",
  signature: "dist/vibebloat.sig",
  publicKey: "release/vibebloat.pub",
  publicKeySha256: fingerprintPublicKey(publicKey),
}));

test("Sigstore verification uses pinned public key and detached signature", () => {
  let received: readonly string[] = [];
  expect(verifySigstore(metadata, publicKey, (command) => { received = command; return 0; })).toEqual({
    verified: true,
    message: "Cosign verified controlled release artifact.",
  });
  expect(received).toEqual(["cosign", "verify-blob", "--key", "release/vibebloat.pub", "--signature", "dist/vibebloat.sig", "dist/vibebloat"]);
});

test("Sigstore verification stops before Cosign when pinned key fingerprint differs", () => {
  let invoked = false;
  expect(verifySigstore(metadata, "different public key", () => { invoked = true; return 0; })).toEqual({
    verified: false,
    message: "Pinned public key fingerprint does not match release metadata.",
  });
  expect(invoked).toBe(false);
});

test("Sigstore verification reports Cosign failures", () => {
  expect(verifySigstore(metadata, publicKey, () => 1)).toEqual({
    verified: false,
    message: "Cosign verification failed with exit code 1.",
  });
});

test("release metadata rejects unsafe paths and unpinned fingerprints", () => {
  expect(() => parseReleaseMetadata("not-json")).toThrow("not valid JSON");
  expect(() => parseReleaseMetadata(JSON.stringify({ ...metadata, artifact: "../vibebloat" }))).toThrow("relative path");
  expect(() => parseReleaseMetadata(JSON.stringify({ ...metadata, artifact: "C:\\\\temp\\\\vibebloat" }))).toThrow("relative path");
  expect(() => parseReleaseMetadata(JSON.stringify({ ...metadata, publicKeySha256: "A".repeat(64) }))).toThrow("lowercase SHA-256");
});
