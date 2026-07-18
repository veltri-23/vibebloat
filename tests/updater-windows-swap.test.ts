import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  scheduleWindowsBinarySwap,
  stageWindowsBinarySwap,
  windowsSwapHelperScript,
  windowsSwapLaunch,
  type WindowsSwapLaunch,
} from "../src/updater/windows-swap";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-windows-swap-"));
  roots.push(root);
  const binaryPath = join(root, "vibebloat.exe");
  const powershellPath = join(root, "powershell.exe");
  writeFileSync(binaryPath, "old-binary");
  writeFileSync(powershellPath, "test-powershell");
  return { root, binaryPath, powershellPath };
}

function systemPowerShell(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

test("stages verified bytes and a digest-bound confined plan", () => {
  const value = fixture();
  const bundle = stageWindowsBinarySwap({
    binaryPath: value.binaryPath,
    candidate: Buffer.from("new-binary"),
    parentPid: 42,
    powershellPath: value.powershellPath,
  });
  const plan = JSON.parse(readFileSync(bundle.planPath, "utf8"));

  expect(plan.parentPid).toBe(42);
  expect(plan.binaryPath).toBe(value.binaryPath);
  expect(plan.workDirectory).toBe(bundle.workDirectory);
  expect(readFileSync(plan.candidatePath, "utf8")).toBe("new-binary");
  expect(existsSync(plan.backupPath)).toBeFalse();
  expect(plan.originalSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(readFileSync(bundle.helperPath, "utf8")).toBe(windowsSwapHelperScript);
  expect(bundle.planSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("launch uses literal arguments without a command shell", () => {
  const value = fixture();
  const bundle = stageWindowsBinarySwap({
    binaryPath: value.binaryPath,
    candidate: Buffer.from("new-binary"),
    parentPid: 42,
    powershellPath: value.powershellPath,
  });
  const launch = windowsSwapLaunch(bundle);

  expect(launch.command).toBe(value.powershellPath);
  expect(launch.arguments).toContain(bundle.helperPath);
  expect(launch.arguments).toContain(bundle.planPath);
  expect(launch.arguments).toContain(bundle.planSha256);
  expect(launch.arguments.join(" ")).not.toContain("-Command");
  expect(windowsSwapHelperScript).toContain("Wait-Process");
  expect(windowsSwapHelperScript).toContain("[IO.File]::Replace");
});

test("failed detached launch removes staged executable bytes", () => {
  const value = fixture();
  let captured: WindowsSwapLaunch | undefined;

  expect(() => scheduleWindowsBinarySwap({
    binaryPath: value.binaryPath,
    candidate: Buffer.from("new-binary"),
    parentPid: 42,
    powershellPath: value.powershellPath,
  }, (launch) => {
    captured = launch;
    throw new Error("spawn failed");
  })).toThrow("spawn failed");

  expect(captured?.command).toBe(value.powershellPath);
  expect(existsSync(captured!.arguments[captured!.arguments.indexOf("-PlanPath") + 1])).toBeFalse();
  expect(readFileSync(value.binaryPath, "utf8")).toBe("old-binary");
});

test("invalid parent PID and linked binary fail before staging", () => {
  const value = fixture();
  expect(() => stageWindowsBinarySwap({
    binaryPath: value.binaryPath,
    candidate: Buffer.from("new-binary"),
    parentPid: 0,
    powershellPath: value.powershellPath,
  })).toThrow("parent PID");
  expect(readFileSync(value.binaryPath, "utf8")).toBe("old-binary");
});

test.skipIf(process.platform !== "win32")("helper applies candidate only after its doctor passes", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-windows-swap-live-"));
  roots.push(root);
  const binaryPath = join(root, "vibebloat.cmd");
  writeFileSync(binaryPath, "@echo old>\"%~dp0marker.txt\"\r\n@exit /b 0\r\n");
  const bundle = stageWindowsBinarySwap({
    binaryPath,
    candidate: Buffer.from("@echo new>\"%~dp0marker.txt\"\r\n@exit /b 0\r\n"),
    parentPid: 2_147_483_647,
    powershellPath: systemPowerShell(),
  });

  const result = Bun.spawnSync([bundle.powershellPath, ...windowsSwapLaunch(bundle).arguments], { stdout: "pipe", stderr: "pipe" });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(readFileSync(binaryPath, "utf8")).toContain("echo new");
  expect(readFileSync(join(root, "marker.txt"), "utf8").trim()).toBe("new");
  expect(JSON.parse(readFileSync(join(root, ".vibebloat.cmd.update-result.json"), "utf8")).status).toBe("applied");
});

test.skipIf(process.platform !== "win32")("helper restores prior binary when candidate doctor fails", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-windows-swap-live-"));
  roots.push(root);
  const binaryPath = join(root, "vibebloat.cmd");
  writeFileSync(binaryPath, "@echo old>\"%~dp0marker.txt\"\r\n@exit /b 0\r\n");
  const bundle = stageWindowsBinarySwap({
    binaryPath,
    candidate: Buffer.from("@echo bad>\"%~dp0marker.txt\"\r\n@exit /b 1\r\n"),
    parentPid: 2_147_483_647,
    powershellPath: systemPowerShell(),
  });

  const result = Bun.spawnSync([bundle.powershellPath, ...windowsSwapLaunch(bundle).arguments], { stdout: "pipe", stderr: "pipe" });

  expect(result.exitCode, result.stderr.toString()).toBe(10);
  expect(readFileSync(binaryPath, "utf8")).toContain("echo old");
  expect(readFileSync(join(root, "marker.txt"), "utf8").trim()).toBe("old");
  expect(JSON.parse(readFileSync(join(root, ".vibebloat.cmd.update-result.json"), "utf8")).status).toBe("rolled-back");
});

test.skipIf(process.platform !== "win32")("helper rejects a tampered or path-escaping plan before swap", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-windows-swap-live-"));
  roots.push(root);
  const binaryPath = join(root, "vibebloat.cmd");
  writeFileSync(binaryPath, "@exit /b 0\r\n");
  const bundle = stageWindowsBinarySwap({
    binaryPath,
    candidate: Buffer.from("@exit /b 0\r\n"),
    parentPid: 2_147_483_647,
    powershellPath: systemPowerShell(),
  });
  const plan = JSON.parse(readFileSync(bundle.planPath, "utf8"));
  plan.resultPath = join(root, "..", "escaped.json");
  const tamperedPlan = `${JSON.stringify(plan, null, 2)}\n`;
  writeFileSync(bundle.planPath, tamperedPlan);

  const digestFailure = Bun.spawnSync([bundle.powershellPath, ...windowsSwapLaunch(bundle).arguments], { stdout: "pipe", stderr: "pipe" });
  expect(digestFailure.exitCode).toBe(1);
  expect(readFileSync(binaryPath, "utf8")).toContain("exit /b 0");

  const escapedLaunch = windowsSwapLaunch({ ...bundle, planSha256: digest(tamperedPlan) });
  const confinementFailure = Bun.spawnSync([bundle.powershellPath, ...escapedLaunch.arguments], { stdout: "pipe", stderr: "pipe" });
  expect(confinementFailure.exitCode).toBe(1);
  expect(readFileSync(binaryPath, "utf8")).toContain("exit /b 0");
  expect(existsSync(join(root, "..", "escaped.json"))).toBeFalse();
});
