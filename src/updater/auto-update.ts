import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReleaseMetadata, verifySigstore, type ReleaseMetadata } from "../doctor/sigstore";
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
  const verification = verifySigstore(metadata, publicKey, run);
  if (!verification.verified) throw new Error(`Update rejected: ${verification.message}`);

  const binary = readFileSync(metadata.artifact);
  const backup = createRollback(binaryPath);
  writeFileSync(binaryPath, binary);
  if (doctor()) return;
  rollback(binaryPath, backup);
  throw new Error("Update rolled back because doctor failed.");
}

function resolveReleasePaths(metadata: ReleaseMetadata, releaseDirectory: string): ReleaseMetadata {
  return {
    ...metadata,
    artifact: join(releaseDirectory, metadata.artifact),
    signature: join(releaseDirectory, metadata.signature),
    publicKey: join(releaseDirectory, metadata.publicKey),
  };
}
