#!/usr/bin/env node
// postinstall: ensure a Bun runtime is available for the shim.
// The package's source code uses Bun-specific APIs (Bun.spawn, Bun.stdin,
// Bun.build), so the bin/vibebloat.js shim depends on a Bun binary on
// PATH. This postinstall fetches a copy of Bun into the user's data dir
// (~/.vibebloat/bin/bun) so the shim can find it even on a Node-only
// machine. The shim also falls back to on-demand download on first use.
import { existsSync, mkdirSync, chmodSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { rename, copyFile } from "node:fs/promises";

const v = process.env.VIBEBLOAT_BUN_VERSION ?? "1.3.14";
const isWin = process.platform === "win32";
const arch = process.arch === "arm64" ? "aarch64" : "x64";
const platform = process.platform === "darwin" ? "darwin" : (isWin ? "windows" : "linux");
const url = `https://github.com/oven-sh/bun/releases/download/bun-v${v}/bun-${platform}-${arch}.zip`;
const home = process.env.VIBEBLOAT_HOME ?? join(tmpdir(), "vibebloat");
const binDir = join(home, "bin");
const binPath = join(binDir, isWin ? "bun.exe" : "bun");

if (existsSync(binPath)) {
  process.stdout.write(`[vibebloat postinstall] bun already at ${binPath}\n`);
  process.exit(0);
}

const unzipCmd = isWin ? "tar" : "unzip";
const unzipArgs = isWin
  ? ["-xf", url, "-C", binDir]
  : ["-o", url, "-d", binDir];

// Use system unzip/tar if available, else fall back to skipping (shim
// handles on-demand download).
try {
  mkdirSync(binDir, { recursive: true });
  const result = spawn(unzipCmd, unzipArgs, { stdio: "ignore" });
  await new Promise((resolve) => {
    result.on("exit", (code) => resolve(code === 0 ? null : code));
  });
  if (existsSync(binPath)) {
    chmodSync(binPath, 0o755);
    process.stdout.write(`[vibebloat postinstall] cached bun at ${binPath}\n`);
    process.exit(0);
  }
  throw new Error(`unzip completed but ${binPath} is missing`);
} catch (error) {
  process.stderr.write(`[vibebloat postinstall] bun cache failed: ${error instanceof Error ? error.message : "unknown"}.\nThe shim will retry on first use.\n`);
  // Non-fatal: shim falls back to on-demand download.
}
