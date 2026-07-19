import { createHash } from "node:crypto";

export interface ReleaseMetadata {
  schemaVersion: 1;
  version: string;
  artifact: string;
  bundle: string;
  publicKey: string;
  publicKeySha256: string;
}

export interface SigstoreVerification {
  verified: boolean;
  message: string;
}

type CommandRunner = (command: readonly string[]) => number;

function releasePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Release metadata ${field} must be a non-empty relative path.`);
  }
  return value;
}

export function parseReleaseMetadata(text: string): ReleaseMetadata {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Release metadata is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release metadata must be an object.");

  const metadata = value as Record<string, unknown>;
  if (metadata.schemaVersion !== 1) throw new Error("Release metadata schemaVersion must be 1.");
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error("Release metadata version must be a semantic version.");
  }
  if (typeof metadata.publicKeySha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.publicKeySha256)) {
    throw new Error("Release metadata publicKeySha256 must be a lowercase SHA-256 digest.");
  }

  return {
    schemaVersion: 1,
    version: metadata.version,
    artifact: releasePath(metadata.artifact, "artifact"),
    bundle: releasePath(metadata.bundle, "bundle"),
    publicKey: releasePath(metadata.publicKey, "publicKey"),
    publicKeySha256: metadata.publicKeySha256,
  };
}

export function fingerprintPublicKey(publicKey: string | Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

export function verifySigstore(metadata: ReleaseMetadata, publicKey: string | Uint8Array, run: CommandRunner): SigstoreVerification {
  if (fingerprintPublicKey(publicKey) !== metadata.publicKeySha256) {
    return { verified: false, message: "Pinned public key fingerprint does not match release metadata." };
  }

  const exitCode = run(["cosign", "verify-blob", "--key", metadata.publicKey, "--bundle", metadata.bundle, metadata.artifact]);
  return exitCode === 0
    ? { verified: true, message: "Cosign verified controlled release artifact." }
    : { verified: false, message: `Cosign verification failed with exit code ${exitCode}.` };
}
