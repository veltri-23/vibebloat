import { installGuardPack, type StarterGuardPackInstallReport } from "../install/starter-pack";
import { parseGuard } from "../schema";
import type { Guard } from "../types";

const starGuardValues = [
  {
    schemaVersion: 1,
    id: "star-git-checkout-discard",
    class: "A",
    provenance: {
      incident: "Star-pack rule for git checkout . discarding uncommitted edits.",
      date: "2026-07-18",
      source: "vibebloat-star-pack",
    },
    match: { chokepoint: "shell", command: "git checkout", argsContains: ["."] },
    action: {
      type: "block",
      message: "Blocked git checkout . - it discards every uncommitted edit. Scope to git checkout -- <path>.",
      override: "vibebloat allow star-git-checkout-discard --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "star-git-clean-force",
    class: "A",
    provenance: {
      incident: "Star-pack rule for forced git clean deleting untracked files.",
      date: "2026-07-18",
      source: "vibebloat-star-pack",
    },
    match: { chokepoint: "shell", command: "git clean", argsAnyOf: ["-f", "-ff", "-fd", "-df", "-fdx", "-xdf", "-dfx", "-xfd", "--force"] },
    action: {
      type: "block",
      message: "Blocked forced git clean - it deletes untracked files forever. Dry-run with git clean -n first.",
      override: "vibebloat allow star-git-clean-force --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
  {
    schemaVersion: 1,
    id: "star-env-file-confirm",
    class: "B",
    provenance: {
      incident: "Star-pack rule for agent writes to .env secret files.",
      date: "2026-07-18",
      source: "vibebloat-star-pack",
    },
    match: { chokepoint: "file", path: ".env" },
    action: {
      type: "require-confirm",
      message: "Paused a write to .env. Secrets live here - confirm the change is intentional.",
      override: "vibebloat allow star-env-file-confirm --once",
    },
    confidence: "high",
    tier: "local",
    binds: [],
    enabled: true,
  },
] as const;

export const defaultStarRepository = "veltri-23/vibebloat";
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const usernamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const maxStargazerPages = 4;

export function starGuardPack(): Guard[] {
  return starGuardValues.map((guard) => parseGuard(structuredClone(guard)));
}

export function starRepository(environment: Record<string, string | undefined> = process.env): string {
  const repository = environment.VIBEBLOAT_GITHUB_REPO ?? defaultStarRepository;
  if (!repositoryPattern.test(repository)) throw new Error(`Invalid GitHub repository slug: ${repository}`);
  return repository;
}

export interface StarVerifyOptions {
  repository?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  attempts?: number;
  delayMs?: number;
}

async function stargazerLogins(page: number, options: Required<Pick<StarVerifyOptions, "repository" | "apiBase" | "fetch">>): Promise<string[]> {
  const response = await options.fetch(
    `${options.apiBase}/repos/${options.repository}/stargazers?per_page=100&page=${page}`,
    { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok) throw new Error(`GitHub stargazers request failed with status ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("GitHub stargazers response was not a list");
  return body
    .map((entry) => (entry && typeof entry === "object" && typeof (entry as { login?: unknown }).login === "string" ? (entry as { login: string }).login : undefined))
    .filter((login): login is string => Boolean(login));
}

export async function verifyGitHubStar(username: string, options: StarVerifyOptions = {}): Promise<boolean> {
  if (!usernamePattern.test(username)) throw new Error(`Invalid GitHub username: ${username}`);
  const resolved = {
    repository: options.repository ?? starRepository(),
    apiBase: options.apiBase ?? process.env.VIBEBLOAT_GITHUB_API ?? "https://api.github.com",
    fetch: options.fetch ?? fetch,
  };
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 2_000;
  const wanted = username.toLowerCase();

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      for (let page = 1; page <= maxStargazerPages; page += 1) {
        const logins = await stargazerLogins(page, resolved);
        if (logins.some((login) => login.toLowerCase() === wanted)) return true;
        if (logins.length < 100) break;
      }
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError instanceof Error ? lastError : new Error("GitHub stargazers request failed");
  return false;
}

export interface StarPackClaimReport extends StarterGuardPackInstallReport {
  repository: string;
  username: string;
}

export async function claimStarPack(username: string, guardDirectory: string, options: StarVerifyOptions = {}): Promise<StarPackClaimReport> {
  const repository = options.repository ?? starRepository();
  const starred = await verifyGitHubStar(username, { ...options, repository });
  if (!starred) {
    throw new Error(`No star from ${username} on ${repository} yet. Star https://github.com/${repository} and rerun.`);
  }
  const report = installGuardPack(starGuardPack(), guardDirectory);
  return { ...report, repository, username };
}
