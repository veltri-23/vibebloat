import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
  guardTransaction?: WindowsSwapGuardTransaction;
}

export interface WindowsSwapGuardTransaction {
  directory: string;
  candidateDirectory: string;
  backupDirectory: string;
  existed: boolean;
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
  guardDirectory: string | null;
  candidateGuardDirectory: string | null;
  guardBackupDirectory: string | null;
  guardDirectoryExisted: boolean;
  candidateGuards: WindowsSwapGuardFile[];
  originalGuards: WindowsSwapGuardFile[];
}

interface WindowsSwapGuardFile {
  name: string;
  sha256: string;
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

function assertRegularDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || !samePath(realpathSync(path), path)) {
    throw new Error("Windows update guard path must be a regular directory without links.");
  }
}

function guardInventory(directory: string): WindowsSwapGuardFile[] {
  assertRegularDirectory(directory);
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink() || entry.name.includes("/") || entry.name.includes("\\")) {
        throw new Error("Windows update guard directory contains an unsupported entry.");
      }
      const path = join(directory, entry.name);
      assertRegularFile(path);
      return { name: entry.name, sha256: sha256(readFileSync(path)) };
    });
}

function guardPlan(transaction: WindowsSwapGuardTransaction | undefined): Pick<WindowsSwapPlan,
  "guardDirectory" | "candidateGuardDirectory" | "guardBackupDirectory" | "guardDirectoryExisted" | "candidateGuards" | "originalGuards"> {
  if (!transaction) {
    return {
      guardDirectory: null,
      candidateGuardDirectory: null,
      guardBackupDirectory: null,
      guardDirectoryExisted: false,
      candidateGuards: [],
      originalGuards: [],
    };
  }
  const guardDirectory = resolve(transaction.directory);
  const candidateGuardDirectory = resolve(transaction.candidateDirectory);
  const guardBackupDirectory = resolve(transaction.backupDirectory);
  const guardParent = realpathSync(dirname(guardDirectory));
  if (!samePath(dirname(guardDirectory), guardParent)
    || !samePath(dirname(candidateGuardDirectory), guardParent)
    || !samePath(dirname(guardBackupDirectory), guardParent)
    || samePath(guardDirectory, candidateGuardDirectory)
    || samePath(guardDirectory, guardBackupDirectory)
    || samePath(candidateGuardDirectory, guardBackupDirectory)
    || existsSync(guardBackupDirectory)) {
    throw new Error("Windows update guard transaction paths must be distinct direct siblings with no existing backup.");
  }
  if (existsSync(guardDirectory) !== transaction.existed) throw new Error("Windows update guard directory state changed before staging.");
  return {
    guardDirectory,
    candidateGuardDirectory,
    guardBackupDirectory,
    guardDirectoryExisted: transaction.existed,
    candidateGuards: guardInventory(candidateGuardDirectory),
    originalGuards: transaction.existed ? guardInventory(guardDirectory) : [],
  };
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
  const guards = guardPlan(options.guardTransaction);
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
      ...guards,
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

function Assert-RegularOwnedDirectory([string]$Path, [string]$Owner) {
  $item = Get-Item -LiteralPath $Path -Force
  if ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Get-Acl -LiteralPath $Path).Owner -eq $Owner) { return }
  throw 'Update directory ownership or type check failed.'
}

function Assert-GuardDirectory([string]$Path, [object[]]$Expected, [string]$Owner) {
  Assert-RegularOwnedDirectory $Path $Owner
  $items = @(Get-ChildItem -LiteralPath $Path -Force)
  if ($items.Count -ne $Expected.Count) { throw 'Update guard inventory count mismatch.' }
  foreach ($entry in $Expected) {
    if ($entry.PSObject.Properties.Name.Count -ne 2 -or $null -eq $entry.name -or $entry.name -match '[\\/]' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') {
      throw 'Update guard inventory schema mismatch.'
    }
    $filePath = [IO.Path]::Combine($Path, [string]$entry.name)
    if (-not (Same-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($filePath))) $Path)) { throw 'Update guard file escaped its directory.' }
    Assert-RegularOwnedFile $filePath $Owner
    if ((Get-Sha256 $filePath) -ne $entry.sha256) { throw 'Update guard digest mismatch.' }
  }
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
$expected = @('backupPath','binaryPath','candidateGuardDirectory','candidateGuards','candidatePath','candidateSha256','guardBackupDirectory','guardDirectory','guardDirectoryExisted','originalGuards','originalSha256','parentPid','resultPath','schemaVersion','workDirectory' | Sort-Object)
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

$hasGuardTransaction = $null -ne $plan.guardDirectory
if ($hasGuardTransaction) {
  if ($null -eq $plan.candidateGuardDirectory -or $null -eq $plan.guardBackupDirectory) { throw 'Update guard transaction is incomplete.' }
  $guardDirectory = [IO.Path]::GetFullPath([string]$plan.guardDirectory)
  $guardParent = [IO.Path]::GetDirectoryName($guardDirectory)
  $candidateGuardDirectory = [IO.Path]::GetFullPath([string]$plan.candidateGuardDirectory)
  $guardBackupDirectory = [IO.Path]::GetFullPath([string]$plan.guardBackupDirectory)
  if (-not (Same-Path ([IO.Path]::GetDirectoryName($candidateGuardDirectory)) $guardParent) -or
      -not (Same-Path ([IO.Path]::GetDirectoryName($guardBackupDirectory)) $guardParent) -or
      (Same-Path $guardDirectory $candidateGuardDirectory) -or
      (Same-Path $guardDirectory $guardBackupDirectory) -or
      (Same-Path $candidateGuardDirectory $guardBackupDirectory) -or
      (Test-Path -LiteralPath $guardBackupDirectory)) {
    throw 'Update guard paths escaped their owned parent.'
  }
} elseif ($null -ne $plan.candidateGuardDirectory -or $null -ne $plan.guardBackupDirectory -or $plan.guardDirectoryExisted -or
    @($plan.candidateGuards).Count -ne 0 -or @($plan.originalGuards).Count -ne 0) {
  throw 'Update guard transaction schema mismatch.'
}

$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ((Get-Acl -LiteralPath $workDirectory).Owner -ne $owner) { throw 'Update directory ownership check failed.' }
Assert-RegularOwnedFile $binaryPath $owner
Assert-RegularOwnedFile $plan.candidatePath $owner
Assert-RegularOwnedFile $PlanPath $owner
Assert-RegularOwnedFile $PSCommandPath $owner
if ($hasGuardTransaction) {
  if ((Test-Path -LiteralPath $guardDirectory) -ne [bool]$plan.guardDirectoryExisted) { throw 'Update guard directory state changed before swap.' }
  Assert-GuardDirectory $candidateGuardDirectory @($plan.candidateGuards) $owner
  if ($plan.guardDirectoryExisted) { Assert-GuardDirectory $guardDirectory @($plan.originalGuards) $owner }
}
if ((Get-Sha256 $plan.candidatePath) -ne $plan.candidateSha256 -or (Get-Sha256 $binaryPath) -ne $plan.originalSha256) {
  throw 'Update payload digest mismatch.'
}

$parent = Get-Process -Id ([int]$plan.parentPid) -ErrorAction SilentlyContinue
if ($null -ne $parent) { $parent | Wait-Process }
if ((Get-Sha256 $PlanPath) -ne $PlanSha256 -or (Get-Sha256 $plan.candidatePath) -ne $plan.candidateSha256 -or (Get-Sha256 $binaryPath) -ne $plan.originalSha256) {
  throw 'Update bundle changed while waiting for parent exit.'
}
if ($hasGuardTransaction) {
  if ((Test-Path -LiteralPath $guardDirectory) -ne [bool]$plan.guardDirectoryExisted -or (Test-Path -LiteralPath $guardBackupDirectory)) {
    throw 'Update guard directory state changed while waiting for parent exit.'
  }
  Assert-GuardDirectory $candidateGuardDirectory @($plan.candidateGuards) $owner
  if ($plan.guardDirectoryExisted) { Assert-GuardDirectory $guardDirectory @($plan.originalGuards) $owner }
}

$failedCandidate = [IO.Path]::Combine($workDirectory, 'failed-candidate.exe')
$guardBackedUp = $false
$guardInstalled = $false
try {
  [IO.File]::Replace($plan.candidatePath, $binaryPath, $plan.backupPath, $true)
  Assert-RegularOwnedFile $plan.backupPath $owner
  if ((Get-Sha256 $plan.backupPath) -ne $plan.originalSha256) { throw 'Atomic swap backup digest mismatch.' }
  if ($hasGuardTransaction) {
    if ($plan.guardDirectoryExisted) {
      Move-Item -LiteralPath $guardDirectory -Destination $guardBackupDirectory
      $guardBackedUp = $true
    }
    Move-Item -LiteralPath $candidateGuardDirectory -Destination $guardDirectory
    $guardInstalled = $true
  }
  & $binaryPath doctor
  if ($LASTEXITCODE -ne 0) { throw 'Candidate doctor failed.' }
  Write-Result 'applied' 'Candidate doctor passed.'
  Remove-Item -LiteralPath $plan.backupPath -Force
  if ($guardBackedUp) { Remove-Item -LiteralPath $guardBackupDirectory -Recurse -Force }
  Remove-Item -LiteralPath $workDirectory -Recurse -Force
  exit 0
} catch {
  try {
    if ($hasGuardTransaction) {
      if ($guardInstalled) {
        if ($plan.guardDirectoryExisted) {
          $failedGuardDirectory = [IO.Path]::Combine($guardParent, ".$([IO.Path]::GetFileName($guardDirectory)).failed-$PID")
          Move-Item -LiteralPath $guardDirectory -Destination $failedGuardDirectory
          Move-Item -LiteralPath $guardBackupDirectory -Destination $guardDirectory
          $guardBackedUp = $false
          Remove-Item -LiteralPath $failedGuardDirectory -Recurse -Force
        } else {
          Remove-Item -LiteralPath $guardDirectory -Recurse -Force
        }
      } elseif ($guardBackedUp) {
        Move-Item -LiteralPath $guardBackupDirectory -Destination $guardDirectory
        $guardBackedUp = $false
      }
    }
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
