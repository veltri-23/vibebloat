import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseReleaseMetadata, verifySigstore } from "../doctor/sigstore";

export interface ControlledScrubberCommands {
  presidio: readonly string[];
  gitleaks: readonly string[];
}

export class ControlledScrubbersUnavailableError extends Error {
  constructor(reason: string = "no signed VibeBloat release found at the configured paths") {
    // Reason wording is intentional: this path is reached whether the
    // release was never signed, the artifacts were never shipped, or
    // verification failed. The fallback tier runs the in-process
    // scrubber either way, so the error wording must not imply a
    // signature was verified.
    super(`Package-controlled scrubber assets are unavailable (unsigned/unverified): ${reason}.`);
  }
}

const controlledScrubberPublicKeySha256: string | undefined = "6deeeb73eb70c7fad0936b1c460bbdb10f785a37098bb06b2de57b9e58f06594";

function containedAbsolutePath(root: string, value: string): string {
  const path = resolve(root, value);
  const pathFromRoot = relative(root, path);
  if (!isAbsolute(path) || pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRoot)) {
    throw new ControlledScrubbersUnavailableError();
  }
  return path;
}

export function resolveControlledScrubberCommands(
  packageRoot = resolve(import.meta.dir, "..", ".."),
): ControlledScrubberCommands {
  try {
    const metadataPath = resolve(packageRoot, "release", "metadata.json");
    if (!existsSync(metadataPath)) throw new ControlledScrubbersUnavailableError("release/metadata.json is missing");

    const metadata = parseReleaseMetadata(readFileSync(metadataPath, "utf8"));
    if (!controlledScrubberPublicKeySha256 || metadata.publicKeySha256 !== controlledScrubberPublicKeySha256) {
      throw new ControlledScrubbersUnavailableError("release/metadata.json publicKeySha256 does not match the pinned fingerprint");
    }
    const artifact = containedAbsolutePath(packageRoot, metadata.artifact);
    const bundle = containedAbsolutePath(packageRoot, metadata.bundle);
    const publicKey = containedAbsolutePath(packageRoot, metadata.publicKey);
    if (![artifact, bundle, publicKey].every((path) => existsSync(path) && lstatSync(path).isFile())) {
      throw new ControlledScrubbersUnavailableError("referenced artifact, bundle, or public key file is missing");
    }

    const verification = verifySigstore(
      { ...metadata, artifact, bundle, publicKey },
      readFileSync(publicKey),
      (command) => Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" }).exitCode ?? 1,
    );
    if (!verification.verified) throw new ControlledScrubbersUnavailableError(`cosign verification reported unverified: ${verification.message}`);

    // Probe the signed binary: must accept the "scrub" subcommand.
    const probe = Bun.spawnSync([artifact, "__distribution_probe__"], { stdout: "pipe", stderr: "pipe" });
    if (probe.exitCode !== 0) throw new ControlledScrubbersUnavailableError("signed binary probe did not advertise vibebloat:dist:ok");
    if (!new TextDecoder().decode(probe.stdout).includes("vibebloat:dist:ok")) {
      throw new ControlledScrubbersUnavailableError("signed binary probe did not advertise vibebloat:dist:ok");
    }

    // Reject env-var scrubber overrides that don't match the signed binary.
    const signedPresidio = JSON.stringify([artifact, "scrub", "presidio", "--json"]);
    const signedGitleaks = JSON.stringify([artifact, "scrub", "gitleaks", "--json"]);
    const envPresidio = process.env.VIBEBLOAT_PRESIDIO_COMMAND;
    const envGitleaks = process.env.VIBEBLOAT_GITLEAKS_COMMAND;
    if (envPresidio && envPresidio !== signedPresidio) {
      throw new ControlledScrubbersUnavailableError("VIBEBLOAT_PRESIDIO_COMMAND override does not match the signed binary");
    }
    if (envGitleaks && envGitleaks !== signedGitleaks) {
      throw new ControlledScrubbersUnavailableError("VIBEBLOAT_GITLEAKS_COMMAND override does not match the signed binary");
    }

    return {
      presidio: [artifact, "scrub", "presidio", "--json"],
      gitleaks: [artifact, "scrub", "gitleaks", "--json"],
    };
  } catch (error) {
    if (error instanceof ControlledScrubbersUnavailableError) throw error;
    throw new ControlledScrubbersUnavailableError(`unexpected error while resolving controlled scrubbers: ${error instanceof Error ? error.message : "unknown"}`);
  }
}
