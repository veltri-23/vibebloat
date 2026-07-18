import { closeSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  assertReleaseArtifacts,
  RELEASE_ARTIFACTS,
  releaseArtifactById,
  selectReleaseArtifact,
  type ReleaseArtifact,
} from "../src/distribution/release";

const root = resolve(import.meta.dir, "..");
const treeSitterIndex = /node_modules[\\/]tree-sitter[\\/]index\.js$/;
const typeAssignment = "nodeSubclass.prototype.type = typeName;";

function fail(reason: string): never {
  process.stderr.write([
    "WHAT failed: standalone release build.",
    `WHY: ${reason}`,
    "FIX: bun scripts/build.ts --target windows-x64|macos-x64|macos-arm64|linux-x64",
  ].join("\n") + "\n");
  process.exit(1);
}

function requestedArtifacts(args: string[]): readonly ReleaseArtifact[] {
  if (args.length === 0) {
    const current = selectReleaseArtifact(process.platform, process.arch);
    return current ? [current] : fail(`unsupported host ${process.platform}-${process.arch}.`);
  }
  if (args.length === 1 && args[0] === "--all") return RELEASE_ARTIFACTS;
  if (args.length === 2 && args[0] === "--target") {
    const selected = releaseArtifactById(args[1]!);
    return selected ? [selected] : fail(`unsupported target ${args[1]}.`);
  }
  return fail("expected no arguments, --all, or --target <platform-arch>.");
}

const artifacts = requestedArtifacts(Bun.argv.slice(2));
const distributionRoot = resolve(root, "dist");
mkdirSync(distributionRoot, { recursive: true });

for (const artifact of artifacts) {
  const outfile = resolve(distributionRoot, artifact.filename);
  const nativeBuild = artifact.platform === process.platform && artifact.arch === process.arch;
  const extension = artifact.filename.endsWith(".exe") ? ".exe" : "";
  const candidate = resolve(distributionRoot, `.build-${artifact.id}-${process.pid}-${randomUUID()}${extension}`);
  const lock = resolve(distributionRoot, `.build-${artifact.id}.lock`);
  let lockDescriptor: number | null = null;
  const deadline = Date.now() + 60_000;
  while (lockDescriptor === null && Date.now() < deadline) {
    try {
      lockDescriptor = openSync(lock, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await Bun.sleep(100);
    }
  }
  if (lockDescriptor === null) fail(`${artifact.id} build remained locked for 60 seconds.`);

  try {
    const result = await Bun.build({
      entrypoints: [resolve(root, "src/cli.ts")],
      compile: nativeBuild ? { outfile: candidate } : { target: artifact.bunTarget, outfile: candidate },
      define: { VIBEBLOAT_STANDALONE: "true" },
      plugins: [{
        name: "tree-sitter-standalone",
        setup(build) {
          build.onResolve({ filter: /^node-gyp-build$/ }, () => ({ path: resolve(root, "src/parser/node-gyp-build.cjs") }));
          build.onLoad({ filter: treeSitterIndex }, async (args) => {
            const source = await Bun.file(args.path).text();
            if (!source.includes(typeAssignment)) throw new Error("Unsupported tree-sitter runtime source.");
            return {
              contents: source.replace(typeAssignment, "// Bun standalone runs in strict mode; inherited type getter remains correct."),
              loader: "js",
            };
          });
        },
      }],
    });

    if (!result.success) {
      for (const log of result.logs) console.error(log);
      process.exitCode = 1;
      break;
    }
    rmSync(outfile, { force: true });
    renameSync(candidate, outfile);
  } finally {
    rmSync(candidate, { force: true });
    closeSync(lockDescriptor);
    rmSync(lock, { force: true });
  }
}

if (process.exitCode) process.exit(process.exitCode);
assertReleaseArtifacts(root, artifacts);
