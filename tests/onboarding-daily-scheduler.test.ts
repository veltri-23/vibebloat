import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dailySchedulerReceiptPath,
  installVerifiedStandaloneDailyScheduler,
  type SchedulerCommandResult,
} from "../src/install/daily-scheduler";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function executable(path: string): string {
  writeFileSync(path, "controlled executable\n");
  chmodSync(path, 0o700);
  return path;
}

test("source checkout targets are rejected before scheduler state or native tools are touched", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-onboarding-daily-"));
  roots.push(root);
  const home = join(root, "home");
  const userHome = join(root, "user");
  mkdirSync(home);
  mkdirSync(userHome);
  let commandCount = 0;

  expect(() => installVerifiedStandaloneDailyScheduler({
    home,
    userHome,
    selfCommand: [process.execPath, join(import.meta.dir, "../src/cli.ts")],
    standalone: false,
    platform: "win32",
    runner: () => {
      commandCount += 1;
      return { exitCode: 0 };
    },
  })).toThrow("source checkout targets are not schedulable");
  expect(commandCount).toBe(0);
  expect(existsSync(dailySchedulerReceiptPath(home))).toBeFalse();
});

test("verified standalone target is scheduled and receipted only after native verification", () => {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-onboarding-daily-"));
  roots.push(root);
  const home = join(root, "home");
  const userHome = join(root, "user");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(userHome);
  mkdirSync(bin);
  const app = executable(join(bin, "vibebloat.exe"));
  const powershell = executable(join(bin, "powershell.exe"));
  const schtasks = executable(join(bin, "schtasks.exe"));
  let nativePresent = false;
  const runner = (command: readonly string[]): SchedulerCommandResult => {
    if (command[0] === powershell) {
      if (!nativePresent) return { exitCode: 3 };
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          execute: app,
          arguments: "daily",
          enabled: true,
          daysInterval: 1,
          triggerEnabled: true,
          hour: 3,
          minute: 0,
        }),
      };
    }
    if (command[0] === schtasks && command[1] === "/Create") {
      expect(existsSync(dailySchedulerReceiptPath(home))).toBeFalse();
      nativePresent = true;
      return { exitCode: 0 };
    }
    return { exitCode: 99, stderr: "unexpected command" };
  };

  const receipt = installVerifiedStandaloneDailyScheduler({
    home,
    userHome,
    selfCommand: [app],
    standalone: true,
    platform: "win32",
    runner,
    nativeExecutables: { powershell, schtasks },
  });

  expect(receipt.command).toEqual([app, "daily"]);
  expect(receipt.target).toBe("\\VibeBloat\\Daily");
  expect(existsSync(dailySchedulerReceiptPath(home))).toBeTrue();
});
