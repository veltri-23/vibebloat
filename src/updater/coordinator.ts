import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fingerprintPublicKey, parseReleaseMetadata, verifySigstore, type ReleaseMetadata } from "../doctor/sigstore";
import { applyAtomicFilePlans } from "../install/atomic-files";
import { parseGuard } from "../schema";
import type { Guard } from "../types";
import { replaceBinaryAtomically } from "./auto-update";
import { diffCommunityGuards, formatGuardDiff, type CommunityGuardDiff } from "./guard-diff";
import { createRollback, rollback } from "./rollback";

type CommandRunner = (command: readonly string[]) => number;

export type UpdateFailureCode = "verification" | "candidate-doctor" | "rollback";

export class UpdateCoordinatorError extends Error {
  constructor(readonly code: UpdateFailureCode, readonly currentVersion: string, readonly candidateVersion?: string, options?: ErrorOptions) {
    super(code === "verification"
      ? "Controlled release verification or guard diff validation failed."
      : code === "candidate-doctor"
        ? "Candidate health check failed and the prior installation was restored."
        : "Candidate health check failed and the prior installation could not be restored.", options);
    this.name = "UpdateCoordinatorError";
  }
}

interface ControlledUpdateMetadata extends ReleaseMetadata {
  communityGuardManifest: string;
  communityGuardManifestSignature: string;
}

interface CommunityGuardManifest {
  schemaVersion: 1;
  guards: Guard[];
}

interface CommunityGuardManifestEnvelope {
  schemaVersion: 1;
  guards: unknown[];
}

export interface UpdateCoordinatorOptions {
  binaryPath: string;
  communityGuardDirectory: string;
  releaseDirectory: string;
  metadataText: string;
  pinnedPublicKey: string | Uint8Array;
  currentVersion: string;
  run: CommandRunner;
  doctor: () => boolean;
  apply?: boolean;
  automatic?: boolean;
  receiptPath?: string;
  now?: () => Date;
}

export interface UpdateCoordinatorResult {
  applied: boolean;
  currentVersion: string;
  candidateVersion: string;
  diff: CommunityGuardDiff;
  preview: string;
  receipt?: string;
}

const metadataFields = new Set([
  "schemaVersion",
  "version",
  "artifact",
  "signature",
  "publicKey",
  "publicKeySha256",
  "communityGuardManifest",
  "communityGuardManifestSignature",
]);
const manifestFields = new Set(["schemaVersion", "guards"]);
const guardFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

function verificationFailure(currentVersion: string, candidateVersion?: string, cause?: unknown): UpdateCoordinatorError {
  return new UpdateCoordinatorError("verification", currentVersion, candidateVersion, { cause });
}

function relativeReleasePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.startsWith("\\")
    || /^[A-Za-z]:/.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid controlled release ${field}.`);
  }
  return value;
}

function parseControlledMetadata(text: string): ControlledUpdateMetadata {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Controlled release metadata is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Controlled release metadata must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !metadataFields.has(field)) || Object.keys(record).length !== metadataFields.size) {
    throw new Error("Controlled release metadata must use the closed update schema.");
  }
  const base = parseReleaseMetadata(text);
  return {
    ...base,
    communityGuardManifest: relativeReleasePath(record.communityGuardManifest, "community guard manifest path"),
    communityGuardManifestSignature: relativeReleasePath(record.communityGuardManifestSignature, "community guard manifest signature path"),
  };
}

function releasePath(directory: string, relativePath: string): string {
  const root = resolve(directory);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error("Controlled release path escaped its directory.");
  if (lstatSync(path).isSymbolicLink()) throw new Error("Controlled release files cannot be symbolic links.");
  return path;
}

function resolvedMetadata(metadata: ControlledUpdateMetadata, directory: string): ControlledUpdateMetadata {
  return {
    ...metadata,
    artifact: releasePath(directory, metadata.artifact),
    signature: releasePath(directory, metadata.signature),
    publicKey: releasePath(directory, metadata.publicKey),
    communityGuardManifest: releasePath(directory, metadata.communityGuardManifest),
    communityGuardManifestSignature: releasePath(directory, metadata.communityGuardManifestSignature),
  };
}

function parseCommunityGuardManifestEnvelope(text: string): CommunityGuardManifestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Community guard manifest is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Community guard manifest must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((field) => !manifestFields.has(field)) || Object.keys(record).length !== manifestFields.size
    || record.schemaVersion !== 1 || !Array.isArray(record.guards)) {
    throw new Error("Community guard manifest must use closed schema version 1.");
  }
  return { schemaVersion: 1, guards: record.guards };
}

function validateCommunityGuardManifest(manifest: CommunityGuardManifestEnvelope): CommunityGuardManifest {
  const guards = manifest.guards.map(parseGuard);
  diffCommunityGuards([], guards);
  return { schemaVersion: 1, guards };
}

export function parseCommunityGuardManifest(text: string): CommunityGuardManifest {
  return validateCommunityGuardManifest(parseCommunityGuardManifestEnvelope(text));
}

function loadInstalledCommunityGuards(directory: string): Guard[] {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Community guard directory cannot be a symbolic link.");
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isFile() || !guardFilePattern.test(entry.name)) throw new Error("Installed community guard directory contains an unsupported entry.");
      const guard = parseGuard(JSON.parse(readFileSync(join(directory, entry.name), "utf8")));
      if (`${guard.id}.json` !== entry.name) throw new Error("Installed community guard filename does not match its ID.");
      return guard;
    });
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyControlledRelease(
  metadata: ControlledUpdateMetadata,
  pinnedPublicKey: string | Uint8Array,
  run: CommandRunner,
): { binary: Uint8Array; manifestText: string } {
  const releasePublicKey = readFileSync(metadata.publicKey);
  if (fingerprintPublicKey(releasePublicKey) !== fingerprintPublicKey(pinnedPublicKey)) throw new Error("Controlled release key does not match the pinned key.");
  const binary = readFileSync(metadata.artifact);
  const manifestText = readFileSync(metadata.communityGuardManifest, "utf8");
  const expectedBinaryDigest = digest(binary);
  const expectedManifestDigest = digest(manifestText);
  if (!verifySigstore(metadata, releasePublicKey, run).verified) throw new Error("Controlled release binary verification failed.");
  const manifestVerification = verifySigstore({
    ...metadata,
    artifact: metadata.communityGuardManifest,
    signature: metadata.communityGuardManifestSignature,
  }, releasePublicKey, run);
  if (!manifestVerification.verified) throw new Error("Controlled release guard manifest verification failed.");
  if (digest(readFileSync(metadata.artifact)) !== expectedBinaryDigest
    || digest(readFileSync(metadata.communityGuardManifest, "utf8")) !== expectedManifestDigest
    || fingerprintPublicKey(readFileSync(metadata.publicKey)) !== fingerprintPublicKey(releasePublicKey)) {
    throw new Error("Controlled release files changed during verification.");
  }
  return { binary, manifestText };
}

function canonicalGuardFile(guard: Guard): string {
  return `${JSON.stringify(guard, null, 2)}\n`;
}

interface DirectoryBackup {
  path: string;
  existed: boolean;
}

function backupDirectory(directory: string): DirectoryBackup {
  const path = join(dirname(directory), `.${basename(directory)}.${randomUUID()}.rollback`);
  const existed = existsSync(directory);
  if (existed) {
    if (lstatSync(directory).isSymbolicLink()) throw new Error("Community guard directory cannot be a symbolic link.");
    cpSync(directory, path, { recursive: true, errorOnExist: true });
  } else {
    mkdirSync(path, { recursive: false });
  }
  return { path, existed };
}

function stageCommunityGuards(directory: string, guards: readonly Guard[]): string {
  mkdirSync(dirname(directory), { recursive: true });
  const staged = join(dirname(directory), `.${basename(directory)}.${randomUUID()}.update`);
  mkdirSync(staged);
  try {
    for (const guard of guards) {
      const path = join(staged, `${guard.id}.json`);
      writeFileSync(path, canonicalGuardFile(guard));
      chmodSync(path, 0o600);
    }
    return staged;
  } catch (error) {
    rmSync(staged, { recursive: true, force: true });
    throw error;
  }
}

function swapDirectory(directory: string, replacement: string): void {
  const displaced = join(dirname(directory), `.${basename(directory)}.${randomUUID()}.displaced`);
  const existed = existsSync(directory);
  if (existed) renameSync(directory, displaced);
  try {
    renameSync(replacement, directory);
  } catch (error) {
    if (existed) renameSync(displaced, directory);
    throw error;
  }
  rmSync(displaced, { recursive: true, force: true });
}

function replaceCommunityGuards(directory: string, guards: readonly Guard[]): void {
  const staged = stageCommunityGuards(directory, guards);
  try {
    swapDirectory(directory, staged);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

function restoreCommunityGuards(directory: string, backup: DirectoryBackup): void {
  if (!backup.existed) {
    rmSync(directory, { recursive: true, force: true });
    return;
  }
  const staged = join(dirname(directory), `.${basename(directory)}.${randomUUID()}.restore`);
  cpSync(backup.path, staged, { recursive: true, errorOnExist: true });
  try {
    swapDirectory(directory, staged);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

function doctorPassed(doctor: () => boolean): boolean {
  try {
    return doctor();
  } catch {
    return false;
  }
}

function updateReceipt(currentVersion: string, candidateVersion: string, preview: string, now: Date): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    kind: "automatic-update-preview",
    currentVersion,
    candidateVersion,
    preview,
    createdAt: now.toISOString(),
    digest: createHash("sha256").update(preview).digest("hex"),
  }, null, 2)}\n`;
}

export function formatUpdateSuccess(currentVersion: string, candidateVersion: string, diff: CommunityGuardDiff): string {
  return [
    `Updated VibeBloat: ${currentVersion} -> ${candidateVersion}`,
    `Guards: ${diff.added.length} added / ${diff.changed.length} changed / ${diff.removed.length} removed`,
    "Doctor: healthy",
    "Rollback: not needed",
  ].join("\n");
}

export function formatUpdateError(error: UpdateCoordinatorError): string {
  if (error.code === "candidate-doctor") {
    return `WHAT failed: update health check failed.\nWHY: vibebloat doctor rejected ${error.candidateVersion}; ${error.currentVersion} was restored.\nFIX: vibebloat doctor\n`;
  }
  if (error.code === "rollback") {
    return `WHAT failed: update rollback failed.\nWHY: doctor rejected ${error.candidateVersion} and ${error.currentVersion} could not be restored.\nFIX: vibebloat install --yes\n`;
  }
  return "WHAT failed: update was not applied.\nWHY: controlled release verification or guard diff validation failed.\nFIX: vibebloat update\n";
}

export function coordinateUpdate(options: UpdateCoordinatorOptions): UpdateCoordinatorResult {
  let candidateVersion: string | undefined;
  try {
    const metadata = resolvedMetadata(parseControlledMetadata(options.metadataText), options.releaseDirectory);
    candidateVersion = metadata.version;
    const verified = verifyControlledRelease(metadata, options.pinnedPublicKey, options.run);
    const candidateEnvelope = parseCommunityGuardManifestEnvelope(verified.manifestText);
    const candidateManifest = validateCommunityGuardManifest(candidateEnvelope);
    const currentGuards = loadInstalledCommunityGuards(resolve(options.communityGuardDirectory));
    const diff = diffCommunityGuards(currentGuards, candidateManifest.guards);
    const preview = formatGuardDiff(options.currentVersion, metadata.version, diff);
    if (!options.apply) return { applied: false, currentVersion: options.currentVersion, candidateVersion: metadata.version, diff, preview };

    let receipt: string | undefined;
    if (options.automatic) {
      if (!options.receiptPath) throw new Error("Automatic update receipt path is required.");
      receipt = updateReceipt(options.currentVersion, metadata.version, preview, (options.now ?? (() => new Date()))());
      applyAtomicFilePlans([{ path: options.receiptPath, content: receipt, mode: 0o600 }]);
    }

    const binaryBackup = createRollback(options.binaryPath);
    let guardBackup: DirectoryBackup;
    try {
      guardBackup = backupDirectory(resolve(options.communityGuardDirectory));
    } catch (error) {
      rmSync(binaryBackup, { force: true });
      throw error;
    }

    try {
      replaceBinaryAtomically(options.binaryPath, verified.binary);
      replaceCommunityGuards(resolve(options.communityGuardDirectory), candidateManifest.guards);
    } catch (error) {
      try {
        rollback(options.binaryPath, binaryBackup);
        restoreCommunityGuards(resolve(options.communityGuardDirectory), guardBackup);
      } catch {
        throw new UpdateCoordinatorError("rollback", options.currentVersion, metadata.version);
      }
      throw error;
    }

    if (doctorPassed(options.doctor)) {
      rmSync(binaryBackup, { force: true });
      rmSync(guardBackup.path, { recursive: true, force: true });
      return { applied: true, currentVersion: options.currentVersion, candidateVersion: metadata.version, diff, preview, ...(receipt ? { receipt } : {}) };
    }

    try {
      rollback(options.binaryPath, binaryBackup);
      restoreCommunityGuards(resolve(options.communityGuardDirectory), guardBackup);
    } catch {
      throw new UpdateCoordinatorError("rollback", options.currentVersion, metadata.version);
    }
    if (!doctorPassed(options.doctor)) throw new UpdateCoordinatorError("rollback", options.currentVersion, metadata.version);
    throw new UpdateCoordinatorError("candidate-doctor", options.currentVersion, metadata.version);
  } catch (error) {
    if (error instanceof UpdateCoordinatorError) throw error;
    throw verificationFailure(options.currentVersion, candidateVersion, error);
  }
}
