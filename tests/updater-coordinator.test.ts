import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintPublicKey } from "../src/doctor/sigstore";
import {
  coordinateUpdate,
  formatUpdateError,
  formatUpdateSuccess,
  parseCommunityGuardManifest,
  UpdateCoordinatorError,
} from "../src/updater/coordinator";
import type { Guard } from "../src/types";

const roots: string[] = [];
const publicKey = "controlled updater test key";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function guard(id: string, command = "git stash"): Guard {
  return {
    schemaVersion: 1,
    id,
    class: "A",
    provenance: { incident: "scrubbed", date: "2026-07-18", source: "community" },
    match: { chokepoint: "shell", command },
    action: { type: "block", message: "stop", override: `vibebloat allow ${id} --once` },
    confidence: "high",
    tier: "community",
    binds: ["codex"],
    enabled: true,
  };
}

function fixture() {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-coordinator-"));
  roots.push(root);
  const release = join(root, "release");
  const community = join(root, "installed", "community");
  const local = join(root, "installed", "local");
  const binary = join(root, "installed", "vibebloat.exe");
  mkdirSync(release, { recursive: true });
  mkdirSync(community, { recursive: true });
  mkdirSync(local, { recursive: true });
  writeFileSync(binary, "old-binary");
  writeFileSync(join(community, "old-guard.json"), `${JSON.stringify(guard("old-guard"))}\n`);
  writeFileSync(join(local, "my-local.json"), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(release, "candidate.exe"), "new-binary");
  writeFileSync(join(release, "candidate.exe.bundle"), "{}");
  writeFileSync(join(release, "community.json.bundle"), "{}");
  writeFileSync(join(release, "vibebloat.pub"), publicKey);
  writeFileSync(join(release, "community.json"), JSON.stringify({ schemaVersion: 1, guards: [guard("new-guard", "git push")] }));
  const metadataText = JSON.stringify({
    schemaVersion: 1,
    version: "0.5.0",
    artifact: "candidate.exe",
    bundle: "candidate.exe.bundle",
    publicKey: "vibebloat.pub",
    publicKeySha256: fingerprintPublicKey(publicKey),
    communityGuardManifest: "community.json",
    communityGuardManifestBundle: "community.json.bundle",
  });
  return { root, release, community, local, binary, metadataText };
}

function options(value: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return {
    binaryPath: value.binary,
    communityGuardDirectory: value.community,
    releaseDirectory: value.release,
    metadataText: value.metadataText,
    pinnedPublicKey: publicKey,
    currentVersion: "0.4.0",
    run: () => 0,
    doctor: () => true,
    apply: true,
    platform: "linux",
    ...overrides,
  };
}

function metadataVersion(value: ReturnType<typeof fixture>, version: string): string {
  return JSON.stringify({ ...JSON.parse(value.metadataText), version });
}

test("closed manifest rejects unknown fields and non-community guards", () => {
  expect(() => parseCommunityGuardManifest(JSON.stringify({ schemaVersion: 1, guards: [], extra: true }))).toThrow("closed schema");
  expect(() => parseCommunityGuardManifest(JSON.stringify({ schemaVersion: 1, guards: [{ ...guard("local"), tier: "local" }] }))).toThrow("not community tier");
});

test("both Cosign verifications finish before backup or installed-file writes", () => {
  const value = fixture();
  let calls = 0;
  expect(() => coordinateUpdate(options(value, {
    run: () => {
      calls += 1;
      expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
      expect(readdirSync(join(value.root, "installed")).filter((name) => name.includes("rollback"))).toEqual([]);
      return calls === 1 ? 0 : 1;
    },
  }))).toThrow(UpdateCoordinatorError);
  expect(calls).toBe(2);
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
});

test("verification failure exposes fixed three-line category and changes nothing", () => {
  const value = fixture();
  let error: UpdateCoordinatorError | undefined;
  try {
    coordinateUpdate(options(value, { run: () => 1 }));
  } catch (caught) {
    error = caught as UpdateCoordinatorError;
  }
  expect(error?.code).toBe("verification");
  expect(formatUpdateError(error!)).toBe("WHAT failed: update was not applied.\nWHY: controlled release verification or guard diff validation failed.\nFIX: vibebloat update\n");
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(existsSync(join(value.community, "old-guard.json"))).toBeTrue();
});

test.each([
  ["same version", "0.4.0", "0.4.0"],
  ["older version", "0.3.99", "0.4.0"],
  ["same precedence with build metadata", "0.4.0+candidate", "0.4.0+installed"],
  ["older prerelease", "1.0.0-beta.1", "1.0.0-beta.2"],
  ["prerelease below stable", "1.0.0-rc.1", "1.0.0"],
])("rejects %s before verification or installed-file writes", (_label, candidateVersion, currentVersion) => {
  const value = fixture();
  let verificationCalls = 0;
  expect(() => coordinateUpdate(options(value, {
    currentVersion,
    metadataText: metadataVersion(value, candidateVersion),
    run: () => ++verificationCalls,
  }))).toThrow(UpdateCoordinatorError);
  expect(verificationCalls).toBe(0);
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
});

test.each([
  ["candidate", "01.0.0", "0.4.0"],
  ["candidate prerelease", "1.0.0-beta.01", "0.4.0"],
  ["current", "0.5.0", "not-semver"],
])("rejects malformed %s version before verification", (_label, candidateVersion, currentVersion) => {
  const value = fixture();
  let verificationCalls = 0;
  expect(() => coordinateUpdate(options(value, {
    currentVersion,
    metadataText: metadataVersion(value, candidateVersion),
    run: () => ++verificationCalls,
  }))).toThrow(UpdateCoordinatorError);
  expect(verificationCalls).toBe(0);
});

test.each([
  ["1.0.0-beta.11", "1.0.0-beta.2"],
  ["1.0.0-beta", "1.0.0-alpha"],
  ["1.0.0", "1.0.0-rc.1"],
])("accepts newer prerelease precedence %s over %s", (candidateVersion, currentVersion) => {
  const value = fixture();
  const result = coordinateUpdate(options(value, {
    apply: false,
    currentVersion,
    metadataText: metadataVersion(value, candidateVersion),
  }));
  expect(result.candidateVersion).toBe(candidateVersion);
});

test("verified artifact bytes cannot change before installed writes", () => {
  const value = fixture();
  let calls = 0;
  expect(() => coordinateUpdate(options(value, {
    run: () => {
      calls += 1;
      if (calls === 2) writeFileSync(join(value.release, "candidate.exe"), "swapped-after-verification");
      return 0;
    },
  }))).toThrow(UpdateCoordinatorError);
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
});

test("preview verifies and prints six lines without backup or mutation", () => {
  const value = fixture();
  const result = coordinateUpdate(options(value, { apply: false }));
  expect(result.applied).toBeFalse();
  expect(result.preview.split("\n")).toHaveLength(6);
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
  expect(readdirSync(join(value.root, "installed")).filter((name) => name.endsWith(".rollback"))).toEqual([]);
});

test("candidate doctor failure atomically restores binary and community guards", () => {
  const value = fixture();
  let calls = 0;
  let error: UpdateCoordinatorError | undefined;
  try {
    coordinateUpdate(options(value, { doctor: () => ++calls === 2 }));
  } catch (caught) {
    error = caught as UpdateCoordinatorError;
  }
  expect(error?.code).toBe("candidate-doctor");
  expect(calls).toBe(2);
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
  expect(formatUpdateError(error!).split("\n")).toHaveLength(4);
});

test("failed restored doctor reports rollback failure and preserves backups", () => {
  const value = fixture();
  let error: UpdateCoordinatorError | undefined;
  try {
    coordinateUpdate(options(value, { doctor: () => false }));
  } catch (caught) {
    error = caught as UpdateCoordinatorError;
  }
  expect(error?.code).toBe("rollback");
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
  expect(readdirSync(join(value.root, "installed")).some((name) => name.endsWith(".rollback"))).toBeTrue();
});

test("successful apply preserves local guards byte-for-byte and formats receipt", () => {
  const value = fixture();
  const localBefore = readFileSync(join(value.local, "my-local.json"));
  const result = coordinateUpdate(options(value));
  expect(result.applied).toBeTrue();
  expect(readFileSync(value.binary, "utf8")).toBe("new-binary");
  expect(readdirSync(value.community)).toEqual(["new-guard.json"]);
  expect(readFileSync(join(value.local, "my-local.json"))).toEqual(localBefore);
  expect(result.preview.split("\n")).toHaveLength(6);
  expect(formatUpdateSuccess("0.4.0", "0.5.0", result.diff)).toBe("Updated VibeBloat: 0.4.0 -> 0.5.0\nGuards: 1 added / 0 changed / 1 removed\nDoctor: healthy\nRollback: not needed");
});

test("automatic apply writes complete verified preview receipt before mutation", () => {
  const value = fixture();
  const receiptPath = join(value.root, "receipts", "update.json");
  const result = coordinateUpdate(options(value, {
    automatic: true,
    receiptPath,
    now: () => new Date("2026-07-18T12:00:00.000Z"),
  }));
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  expect(receipt.preview).toBe(result.preview);
  expect(receipt.createdAt).toBe("2026-07-18T12:00:00.000Z");
  expect(receipt.digest).toMatch(/^[a-f0-9]{64}$/);
});

test("Windows apply schedules one detached binary and guard transaction without mutating live files", () => {
  const value = fixture();
  let scheduled: unknown;
  const result = coordinateUpdate(options(value, {
    platform: "win32",
    windowsSelfUpdateTarget: true,
    scheduleWindowsSwap: (swap: unknown) => { scheduled = swap; },
  }));

  expect(result.applied).toBeFalse();
  expect(result.scheduled).toBeTrue();
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
  const transaction = scheduled as {
    binaryPath: string;
    candidate: Uint8Array;
    guardTransaction: { directory: string; candidateDirectory: string; backupDirectory: string; existed: boolean };
  };
  expect(transaction.binaryPath).toBe(value.binary);
  expect(Buffer.from(transaction.candidate).toString()).toBe("new-binary");
  expect(transaction.guardTransaction.directory).toBe(value.community);
  expect(transaction.guardTransaction.existed).toBeTrue();
  expect(readdirSync(transaction.guardTransaction.candidateDirectory)).toEqual(["new-guard.json"]);
  expect(existsSync(transaction.guardTransaction.backupDirectory)).toBeFalse();
});

test("Windows detached launch failure removes staged guards and leaves live installation unchanged", () => {
  const value = fixture();
  let stagedDirectory = "";
  expect(() => coordinateUpdate(options(value, {
    platform: "win32",
    windowsSelfUpdateTarget: true,
    scheduleWindowsSwap: (swap: { guardTransaction?: { candidateDirectory: string } }) => {
      stagedDirectory = swap.guardTransaction!.candidateDirectory;
      throw new Error("spawn failed");
    },
  }))).toThrow(UpdateCoordinatorError);

  expect(stagedDirectory).not.toBe("");
  expect(existsSync(stagedDirectory)).toBeFalse();
  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
});

test("Windows apply fails closed without a verified standalone self-update target", () => {
  const value = fixture();

  expect(() => coordinateUpdate(options(value, { platform: "win32" }))).toThrow(UpdateCoordinatorError);

  expect(readFileSync(value.binary, "utf8")).toBe("old-binary");
  expect(readdirSync(value.community)).toEqual(["old-guard.json"]);
  expect(readdirSync(join(value.root, "installed")).some((entry) => entry.includes(".update") || entry.includes(".rollback"))).toBeFalse();
});
