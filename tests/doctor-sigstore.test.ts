import { expect, test } from "bun:test";
import { verifySigstore } from "../src/doctor/sigstore";

test("Sigstore verification uses pinned public key and detached signature", () => {
  let received: string[] = [];
  expect(verifySigstore("vibebloat.exe", "keys/demo.pub", (command) => { received = command; return 0; })).toBe(true);
  expect(received).toEqual(["cosign", "verify-blob", "--key", "keys/demo.pub", "--signature", "vibebloat.exe.sig", "vibebloat.exe"]);
});
