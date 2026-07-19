import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
import { scheduleWindowsBinarySwap, type WindowsSwapStageOptions } from "./windows-swap";

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
  communityGuardManifestBundle: string;
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
  platform?: NodeJS.Platform;
  windowsSelfUpdateTarget?: boolean;
  scheduleWindowsSwap?: (options: WindowsSwapStageOptions) => unknown;
}

export interface UpdateCoordinatorResult {
  applied: boolean;
  scheduled?: boolean;
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
  "bundle",
  "publicKey",
  "publicKeySha256",
  "communityGuardManifest",
  "communityGuardManifestBundle",
]);
const manifestFields = new Set(["schemaVersion", "guards"]);
const guardFilePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;
const proofFile = "proof.json";

function verificationFailure(currentVersion: string, candidateVersion?: string, cause?: unknown): UpdateCoordinatorError {
  return new UpdateCoordinatorError("verification", currentVersion, candidateVersion, { cause });
}

interface SemanticVersion {
  core: [string, string, string];
  prerelease?: string[];
}

function parseSemanticVersion(value: string): SemanticVersion {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) throw new Error("Update versions must be valid semantic versions.");
  const prerelease = match[4]?.split(".");
  if (prerelease?.some((identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    throw new Error("Update versions must be valid semantic versions.");
  }
  return { core: [match[1]!, match[2]!, match[3]!], ...(prerelease ? { prerelease } : {}) };
}

function compareNumericIdentifier(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareSemanticVersions(leftValue: string, rightValue: string): number {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);
  for (let index = 0; index < left.core.length; index += 1) {
    const comparison = compareNumericIdentifier(left.core[index]!, right.core[index]!);
    if (comparison !== 0) return comparison;
  }
  if (!left.prerelease || !right.prerelease) return left.prerelease ? -1 : right.prerelease ? 1 : 0;
  const count = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) return leftIdentifier === undefined ? -1 : 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function requireVersionUpgrade(currentVersion: string, candidateVersion: string): void {
  if (compareSemanticVersions(candidateVersion, currentVersion) <= 0) {
    throw new Error("Controlled release version must be newer than the installed version.");
  }
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
    communityGuardManifestBundle: relativeReleasePath(record.communityGuardManifestBundle, "community guard manifest bundle path"),
  };
}

function releasePath(directory: string, relativePath: string): string {
  const root = realpathSync(resolve(directory));
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) throw new Error("Controlled release path escaped its directory.");
  if (lstatSync(path).isSymbolicLink()) throw new Error("Controlled release files cannot be symbolic links.");
  if (realpathSync(path) !== path) throw new Error("Controlled release paths cannot traverse symbolic links.");
  return path;
}

function resolvedMetadata(metadata: ControlledUpdateMetadata, directory: string): ControlledUpdateMetadata {
  return {
    ...metadata,
    artifact: releasePath(directory, metadata.artifact),
    bundle: releasePath(directory, metadata.bundle),
    publicKey: releasePath(directory, metadata.publicKey),
    communityGuardManifest: releasePath(directory, metadata.communityGuardManifest),
    communityGuardManifestBundle: releasePath(directory, metadata.communityGuardManifestBundle),
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

interface InstalledGuardInventory {
  community: Guard[];
  localIds: Set<string>;
}

function loadInstalledGuardInventory(directory: string): InstalledGuardInventory {
  if (!existsSync(directory)) return { community: [], localIds: new Set() };
  if (lstatSync(directory).isSymbolicLink()) throw new Error("Community guard directory cannot be a symbolic link.");
  const guards = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.name === proofFile) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Installed community guard directory contains an unsupported proof entry.");
        return [];
      }
      if (!entry.isFile() || !guardFilePattern.test(entry.name)) throw new Error("Installed community guard directory contains an unsupported entry.");
      const guard = parseGuard(JSON.parse(readFileSync(join(directory, entry.name), "utf8")));
      if (`${guard.id}.json` !== entry.name) throw new Error("Installed community guard filename does not match its ID.");
      return [guard];
    });
  return {
    community: guards.filter((guard) => guard.tier === "community"),
    localIds: new Set(guards.filter((guard) => guard.tier !== "community").map((guard) => guard.id)),
  };
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
    bundle: metadata.communityGuardManifestBundle,
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
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Installed guard directory contains an unsupported entry.");
        if (entry.name === proofFile) {
          copyFileSync(join(directory, entry.name), join(staged, entry.name));
          continue;
        }
        if (!guardFilePattern.test(entry.name)) throw new Error("Installed guard directory contains an unsupported entry.");
        const guard = parseGuard(JSON.parse(readFileSync(join(directory, entry.name), "utf8")));
        if (guard.tier !== "community") copyFileSync(join(directory, entry.name), join(staged, entry.name));
      }
    }
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
    requireVersionUpgrade(options.currentVersion, metadata.version);
    const verified = verifyControlledRelease(metadata, options.pinnedPublicKey, options.run);
    const candidateEnvelope = parseCommunityGuardManifestEnvelope(verified.manifestText);
    const candidateManifest = validateCommunityGuardManifest(candidateEnvelope);
    const inventory = loadInstalledGuardInventory(resolve(options.communityGuardDirectory));
    if (candidateManifest.guards.some((guard) => inventory.localIds.has(guard.id))) throw new Error("Community update conflicts with an installed local guard.");
    const diff = diffCommunityGuards(inventory.community, candidateManifest.guards);
    const preview = formatGuardDiff(options.currentVersion, metadata.version, diff);
    if (!options.apply) return { applied: false, currentVersion: options.currentVersion, candidateVersion: metadata.version, diff, preview };

    const platform = options.platform ?? process.platform;
    if (platform === "win32" && !options.windowsSelfUpdateTarget) {
      throw new Error("Windows updates require a verified standalone self-update target.");
    }

    let receipt: string | undefined;
    if (options.automatic) {
      if (!options.receiptPath) throw new Error("Automatic update receipt path is required.");
      receipt = updateReceipt(options.currentVersion, metadata.version, preview, (options.now ?? (() => new Date()))());
      applyAtomicFilePlans([{ path: options.receiptPath, content: receipt, mode: 0o600 }]);
    }

    const communityGuardDirectory = resolve(options.communityGuardDirectory);
    if (platform === "win32") {
      const stagedGuards = stageCommunityGuards(communityGuardDirectory, candidateManifest.guards);
      const guardBackupDirectory = join(dirname(communityGuardDirectory), `.${basename(communityGuardDirectory)}.${randomUUID()}.rollback`);
      try {
        (options.scheduleWindowsSwap ?? scheduleWindowsBinarySwap)({
          binaryPath: options.binaryPath,
          candidate: verified.binary,
          guardTransaction: {
            directory: communityGuardDirectory,
            candidateDirectory: stagedGuards,
            backupDirectory: guardBackupDirectory,
            existed: existsSync(communityGuardDirectory),
          },
        });
      } catch (error) {
        rmSync(stagedGuards, { recursive: true, force: true });
        throw error;
      }
      return {
        applied: false,
        scheduled: true,
        currentVersion: options.currentVersion,
        candidateVersion: metadata.version,
        diff,
        preview,
        ...(receipt ? { receipt } : {}),
      };
    }

    const binaryBackup = createRollback(options.binaryPath);
    let guardBackup: DirectoryBackup;
    try {
      guardBackup = backupDirectory(communityGuardDirectory);
    } catch (error) {
      rmSync(binaryBackup, { force: true });
      throw error;
    }

    try {
      replaceBinaryAtomically(options.binaryPath, verified.binary);
      replaceCommunityGuards(communityGuardDirectory, candidateManifest.guards);
    } catch (error) {
      try {
        rollback(options.binaryPath, binaryBackup);
        restoreCommunityGuards(communityGuardDirectory, guardBackup);
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
      restoreCommunityGuards(communityGuardDirectory, guardBackup);
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
