import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fingerprintPublicKey, parseReleaseMetadata, verifySigstore, type ReleaseMetadata } from "../doctor/sigstore";
import { createRollback, rollback } from "./rollback";

type CommandRunner = (command: readonly string[]) => number;

export function applyUpdate(
  binaryPath: string,
  releaseDirectory: string,
  metadataText: string,
  publicKey: string | Uint8Array,
  run: CommandRunner,
  doctor: () => boolean,
): void {
  const metadata = resolveReleasePaths(parseReleaseMetadata(metadataText), releaseDirectory);
  const releasePublicKey = readFileSync(metadata.publicKey);
  if (fingerprintPublicKey(releasePublicKey) !== fingerprintPublicKey(publicKey)) {
    throw new Error("Update rejected: release public key does not match the pinned key.");
  }
  const verification = verifySigstore(metadata, releasePublicKey, run);
  if (!verification.verified) throw new Error(`Update rejected: ${verification.message}`);

  const binary = readFileSync(metadata.artifact);
  const backup = createRollback(binaryPath);
  replaceBinaryAtomically(binaryPath, binary);
  if (doctorPassed(doctor)) {
    rmSync(backup, { force: true });
    return;
  }

  try {
    rollback(binaryPath, backup);
  } catch {
    throw new Error("Update rollback failed after candidate doctor failed. Rollback backup preserved.");
  }
  if (!doctorPassed(doctor)) {
    throw new Error("Update rollback health check failed. Rollback backup preserved.");
  }
  throw new Error("Update rolled back because candidate doctor failed. Rollback backup preserved.");
}

function doctorPassed(doctor: () => boolean): boolean {
  try {
    return doctor();
  } catch {
    return false;
  }
}

export function replaceBinaryAtomically(binaryPath: string, binary: Uint8Array): void {
  const temporaryPath = join(dirname(binaryPath), `.${randomUUID()}.update`);
  const mode = statSync(binaryPath).mode;
  try {
    writeFileSync(temporaryPath, binary, { mode });
    chmodSync(temporaryPath, mode);
    renameSync(temporaryPath, binaryPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function resolveReleasePaths(metadata: ReleaseMetadata, releaseDirectory: string): ReleaseMetadata {
  return {
    ...metadata,
    artifact: join(releaseDirectory, metadata.artifact),
    signature: join(releaseDirectory, metadata.signature),
    publicKey: join(releaseDirectory, metadata.publicKey),
  };
}
