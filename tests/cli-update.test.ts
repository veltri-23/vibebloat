import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintPublicKey } from "../src/doctor/sigstore";
import { formatUpdateCommandResult, runControlledUpdateCommand } from "../src/updater/command";
import type { Guard } from "../src/types";

const project = join(import.meta.dir, "..");
const roots: string[] = [];
const unavailable = "WHAT failed: update trust check stopped.\nWHY: installed package lacks controlled release metadata or pinned public key.\nFIX: npx vibebloat@latest update\n";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function invoke(command: readonly string[]) {
  const home = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-cli-update-"));
  roots.push(home);
  return {
    home,
    result: Bun.spawnSync([...command, "update"], {
      cwd: project,
      env: { ...process.env, VIBEBLOAT_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    }),
  };
}

function guard(id: string, tier: "local" | "community", command: string): Guard {
  return {
    schemaVersion: 1,
    id,
    class: "A",
    provenance: { incident: "scrubbed", date: "2026-07-18", source: tier },
    match: { chokepoint: "shell", command },
    action: { type: "block", message: "stop", override: `vibebloat allow ${id} --once` },
    confidence: "high",
    tier,
    binds: ["codex"],
    enabled: true,
  };
}

test("source and package bin fail closed without package-controlled trust assets", () => {
  for (const command of [["bun", "src/cli.ts"], ["bun", "bin/vibebloat.js"]]) {
    const { home, result } = invoke(command);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toBe(unavailable);
    expect(existsSync(join(home, "guards"))).toBeFalse();
  }
});

test("update rejects path, key, and release overrides at the CLI boundary", () => {
  const result = Bun.spawnSync(["bun", "src/cli.ts", "update", "--public-key", "attacker.pub"], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("WHAT failed: update command was rejected.\nWHY: expected no arguments or --apply.\nFIX: vibebloat update\n");
});

test("controlled command verifies both assets and preserves local guard bytes", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-command-update-"));
  roots.push(root);
  const release = join(root, "release");
  const dist = join(root, "dist");
  const guards = join(root, "home", "guards");
  mkdirSync(release, { recursive: true });
  mkdirSync(dist);
  mkdirSync(guards, { recursive: true });

  const publicKey = "controlled command test key";
  const binary = join(root, "installed-vibebloat");
  const localBytes = `${JSON.stringify(guard("local-proof", "local", "git status"))}  \n`;
  writeFileSync(binary, "old-binary");
  writeFileSync(join(dist, "candidate"), "new-binary");
  writeFileSync(join(release, "candidate.bundle"), "{}");
  writeFileSync(join(release, "community.json.bundle"), "{}");
  writeFileSync(join(release, "vibebloat.pub"), publicKey);
  writeFileSync(join(guards, "local-proof.json"), localBytes);
  writeFileSync(join(guards, "old-community.json"), `${JSON.stringify(guard("old-community", "community", "git pull"))}\n`);
  writeFileSync(join(guards, "proof.json"), "{\"installed\":true}\n");
  writeFileSync(join(release, "community.json"), JSON.stringify({
    schemaVersion: 1,
    guards: [guard("new-community", "community", "git push")],
  }));
  writeFileSync(join(release, "metadata.json"), JSON.stringify({
    schemaVersion: 1,
    version: "0.5.0",
    artifact: "dist/candidate",
    bundle: "release/candidate.bundle",
    publicKey: "release/vibebloat.pub",
    publicKeySha256: fingerprintPublicKey(publicKey),
    communityGuardManifest: "release/community.json",
    communityGuardManifestBundle: "release/community.json.bundle",
  }));

  let commandCount = 0;
  const result = runControlledUpdateCommand({
    apply: true,
    communityGuardDirectory: guards,
    currentVersion: "0.4.0",
    doctor: () => true,
    packageRoot: root,
    run: (command) => {
      commandCount += 1;
      expect(command[0]).toBe("cosign");
      return 0;
    },
    selfCommand: [binary],
    platform: "linux",
  });

  expect(commandCount).toBe(2);
  expect(result.applied).toBeTrue();
  expect(formatUpdateCommandResult(result)).toContain("Updated VibeBloat: 0.4.0 -> 0.5.0");
  expect(readFileSync(binary, "utf8")).toBe("new-binary");
  expect(readFileSync(join(guards, "local-proof.json"), "utf8")).toBe(localBytes);
  expect(readFileSync(join(guards, "proof.json"), "utf8")).toBe("{\"installed\":true}\n");
  expect(existsSync(join(guards, "old-community.json"))).toBeFalse();
  expect(existsSync(join(guards, "new-community.json"))).toBeTrue();
});
