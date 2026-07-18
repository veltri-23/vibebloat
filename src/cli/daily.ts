import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { runDailyStrengthening, type DailyStrengtheningResult } from "../compiler/daily";
import { globalGuardHome, guardDirectories, guardHomeForScope, type GuardScope } from "../guard-home";
import { applyAtomicFilePlans } from "../install/atomic-files";

const proposalDirectoryName = "daily";
const proposalFileName = "proposals.json";

export interface DailyCommandOptions {
  scope?: GuardScope;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  proposalLimit?: number;
}

export interface DailyProposalReport extends DailyStrengtheningResult {
  schemaVersion: 1;
  generatedAt: string;
  scope: GuardScope;
}

export interface DailyCommandResult {
  proposalPath: string;
  report: DailyProposalReport;
}

function assertSafeDirectory(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Daily path is unsafe.");
}

function assertSafeJsonFiles(directory: string): void {
  if (!existsSync(directory)) return;
  assertSafeDirectory(directory);
  for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
    const stat = lstatSync(join(directory, file));
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Daily evidence path is unsafe.");
  }
}

function assertClosedPath(home: string, path: string): void {
  const child = relative(home, path);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error("Daily proposal path escaped its local home.");
  }
}

export function formatDailyStrengtheningFailure(): string {
  return "WHAT failed: daily strengthening stopped.\nWHY: installed guards, audit evidence, or proposal storage was unsafe or unreadable.\nFIX: vibebloat doctor\n";
}

export function runDailyStrengtheningCommand(options: DailyCommandOptions = {}): DailyCommandResult {
  const scope = options.scope ?? "machine";
  const environment = options.environment ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(cwd, guardHomeForScope(scope, environment, cwd));
  const globalHome = resolve(cwd, globalGuardHome(environment));
  const directories = guardDirectories(environment, cwd).map((directory) => resolve(cwd, directory));
  const outputDirectory = join(home, proposalDirectoryName);
  const proposalPath = join(outputDirectory, proposalFileName);

  assertClosedPath(home, proposalPath);
  assertSafeDirectory(home);
  assertSafeDirectory(outputDirectory);
  for (const directory of directories) {
    assertSafeDirectory(dirname(directory));
    assertSafeJsonFiles(directory);
  }
  const auditDirectory = join(globalHome, "audit");
  assertSafeDirectory(globalHome);
  assertSafeDirectory(auditDirectory);
  assertSafeJsonFiles(join(auditDirectory, "last-fired"));

  const now = options.now ?? new Date();
  const result = runDailyStrengthening({
    home,
    globalHome,
    guardDirectories: directories,
    now,
    proposalLimit: options.proposalLimit,
  });
  const report: DailyProposalReport = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    scope,
    ...result,
  };

  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  assertSafeDirectory(outputDirectory);
  applyAtomicFilePlans([{ path: proposalPath, content: `${JSON.stringify(report)}\n`, mode: 0o600 }]);
  return { proposalPath, report };
}
