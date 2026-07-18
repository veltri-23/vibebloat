import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface WindowsSwapStageOptions {
  binaryPath: string;
  candidate: Uint8Array;
  parentPid?: number;
  powershellPath?: string;
}

export interface WindowsSwapBundle {
  helperPath: string;
  planPath: string;
  planSha256: string;
  powershellPath: string;
  workDirectory: string;
}

export interface WindowsSwapLaunch {
  command: string;
  arguments: readonly string[];
}

interface WindowsSwapPlan {
  schemaVersion: 1;
  parentPid: number;
  binaryPath: string;
  candidatePath: string;
  backupPath: string;
  resultPath: string;
  workDirectory: string;
  candidateSha256: string;
  originalSha256: string;
}

type DetachedLauncher = (launch: WindowsSwapLaunch) => void;

const helperName = "swap.ps1";
const planName = "plan.json";
const candidateName = "candidate.exe";
const backupName = "backup.exe";

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function samePath(left: string, right: string): boolean {
  return resolve(left).toLowerCase() === resolve(right).toLowerCase();
}

function windowsPowerShellPath(): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function assertRegularFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error("Windows update path must be a regular file without links.");
  }
}

function planText(plan: WindowsSwapPlan): string {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

export function stageWindowsBinarySwap(options: WindowsSwapStageOptions): WindowsSwapBundle {
  if (!Number.isSafeInteger(options.parentPid ?? process.pid) || (options.parentPid ?? process.pid) <= 0) {
    throw new Error("Windows update parent PID is invalid.");
  }
  const binaryPath = resolve(options.binaryPath);
  assertRegularFile(binaryPath);
  const binaryDirectory = realpathSync(dirname(binaryPath));
  if (!samePath(dirname(binaryPath), binaryDirectory)) throw new Error("Windows update binary directory cannot traverse links.");

  const powershellPath = resolve(options.powershellPath ?? windowsPowerShellPath());
  assertRegularFile(powershellPath);
  const workDirectory = join(binaryDirectory, `.${basename(binaryPath)}.${randomUUID()}.update`);
  mkdirSync(workDirectory, { recursive: false, mode: 0o700 });

  try {
    const candidatePath = join(workDirectory, candidateName);
    const backupPath = join(workDirectory, backupName);
    const helperPath = join(workDirectory, helperName);
    const planPath = join(workDirectory, planName);
    const resultPath = join(binaryDirectory, `.${basename(binaryPath)}.update-result.json`);
    const mode = statSync(binaryPath).mode;
    writeFileSync(candidatePath, options.candidate, { mode });
    chmodSync(candidatePath, mode);
    writeFileSync(helperPath, windowsSwapHelperScript, { mode: 0o600 });

    const plan: WindowsSwapPlan = {
      schemaVersion: 1,
      parentPid: options.parentPid ?? process.pid,
      binaryPath,
      candidatePath,
      backupPath,
      resultPath,
      workDirectory,
      candidateSha256: sha256(options.candidate),
      originalSha256: sha256(readFileSync(binaryPath)),
    };
    const serializedPlan = planText(plan);
    writeFileSync(planPath, serializedPlan, { mode: 0o600 });
    return { helperPath, planPath, planSha256: sha256(serializedPlan), powershellPath, workDirectory };
  } catch (error) {
    rmSync(workDirectory, { recursive: true, force: true });
    throw error;
  }
}

export function windowsSwapLaunch(bundle: WindowsSwapBundle): WindowsSwapLaunch {
  return {
    command: bundle.powershellPath,
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      bundle.helperPath,
      "-PlanPath",
      bundle.planPath,
      "-PlanSha256",
      bundle.planSha256,
    ],
  };
}

function launchDetached(launch: WindowsSwapLaunch): void {
  const child = spawn(launch.command, [...launch.arguments], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export function scheduleWindowsBinarySwap(options: WindowsSwapStageOptions, launch: DetachedLauncher = launchDetached): WindowsSwapBundle {
  if (process.platform !== "win32") throw new Error("Detached binary swap is Windows-only.");
  const bundle = stageWindowsBinarySwap(options);
  try {
    launch(windowsSwapLaunch(bundle));
    return bundle;
  } catch (error) {
    rmSync(bundle.workDirectory, { recursive: true, force: true });
    throw error;
  }
}

export const windowsSwapHelperScript = String.raw`param(
  [Parameter(Mandatory = $true)][string]$PlanPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256
)

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Same-Path([string]$Left, [string]$Right) {
  return [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right))
}

function Assert-RegularOwnedFile([string]$Path, [string]$Owner) {
  $item = Get-Item -LiteralPath $Path -Force
  if (-not $item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Get-Acl -LiteralPath $Path).Owner -eq $Owner) { return }
  throw 'Update file ownership or type check failed.'
}

function Write-Result([string]$Status, [string]$Message) {
  $temporary = "$($plan.resultPath).tmp"
  $json = @{ schemaVersion = 1; status = $Status; message = $Message } | ConvertTo-Json -Compress
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temporary, $json, $utf8)
  Move-Item -LiteralPath $temporary -Destination $plan.resultPath -Force
}

if ((Get-Sha256 $PlanPath) -ne $PlanSha256) { throw 'Update plan digest mismatch.' }
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
$fields = @($plan.PSObject.Properties.Name | Sort-Object)
$expected = @('backupPath','binaryPath','candidatePath','candidateSha256','originalSha256','parentPid','resultPath','schemaVersion','workDirectory' | Sort-Object)
if ($plan.schemaVersion -ne 1 -or (Compare-Object $fields $expected)) { throw 'Update plan schema mismatch.' }

$binaryPath = [IO.Path]::GetFullPath($plan.binaryPath)
$binaryDirectory = [IO.Path]::GetDirectoryName($binaryPath)
$workDirectory = [IO.Path]::GetFullPath($plan.workDirectory)
$expectedResultPath = [IO.Path]::Combine($binaryDirectory, ".$([IO.Path]::GetFileName($binaryPath)).update-result.json")
if (-not (Same-Path ([IO.Path]::GetDirectoryName($workDirectory)) $binaryDirectory) -or
    -not (Same-Path $plan.candidatePath ([IO.Path]::Combine($workDirectory, '${candidateName}'))) -or
    -not (Same-Path $plan.backupPath ([IO.Path]::Combine($workDirectory, '${backupName}'))) -or
    -not (Same-Path $PlanPath ([IO.Path]::Combine($workDirectory, '${planName}'))) -or
    -not (Same-Path $PSCommandPath ([IO.Path]::Combine($workDirectory, '${helperName}'))) -or
    -not (Same-Path $plan.resultPath $expectedResultPath)) {
  throw 'Update paths escaped the owned bundle.'
}

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ((Get-Acl -LiteralPath $workDirectory).Owner -ne $owner) { throw 'Update directory ownership check failed.' }
Assert-RegularOwnedFile $binaryPath $owner
Assert-RegularOwnedFile $plan.candidatePath $owner
Assert-RegularOwnedFile $PlanPath $owner
Assert-RegularOwnedFile $PSCommandPath $owner
if ((Get-Sha256 $plan.candidatePath) -ne $plan.candidateSha256 -or (Get-Sha256 $binaryPath) -ne $plan.originalSha256) {
  throw 'Update payload digest mismatch.'
}

$parent = Get-Process -Id ([int]$plan.parentPid) -ErrorAction SilentlyContinue
if ($null -ne $parent) { $parent | Wait-Process }
if ((Get-Sha256 $PlanPath) -ne $PlanSha256 -or (Get-Sha256 $plan.candidatePath) -ne $plan.candidateSha256 -or (Get-Sha256 $binaryPath) -ne $plan.originalSha256) {
  throw 'Update bundle changed while waiting for parent exit.'
}

$failedCandidate = [IO.Path]::Combine($workDirectory, 'failed-candidate.exe')
try {
  [IO.File]::Replace($plan.candidatePath, $binaryPath, $plan.backupPath, $true)
  Assert-RegularOwnedFile $plan.backupPath $owner
  if ((Get-Sha256 $plan.backupPath) -ne $plan.originalSha256) { throw 'Atomic swap backup digest mismatch.' }
  & $binaryPath doctor
  if ($LASTEXITCODE -ne 0) { throw 'Candidate doctor failed.' }
  Write-Result 'applied' 'Candidate doctor passed.'
  Remove-Item -LiteralPath $plan.backupPath -Force
  Remove-Item -LiteralPath $workDirectory -Recurse -Force
  exit 0
} catch {
  try {
    if (-not (Test-Path -LiteralPath $plan.backupPath)) { throw 'Atomic swap did not preserve a rollback binary.' }
    [IO.File]::Replace($plan.backupPath, $binaryPath, $failedCandidate, $true)
    & $binaryPath doctor
    if ($LASTEXITCODE -ne 0) { throw 'Rollback doctor failed.' }
    Write-Result 'rolled-back' 'Candidate doctor failed; prior binary restored.'
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
    exit 10
  } catch {
    Write-Result 'rollback-failed' $_.Exception.Message
    exit 11
  }
}
`;
