import type { Guard, GuardAgent } from "../types";
import type { GuardTestVector } from "./validate";

/**
 * The shipped community guard library.
 *
 * Every entry is a real, repeated AI-agent footgun with a proven, low-false-
 * positive matcher: the positive vector fires and the negative (safe) variant
 * does not, verified through the real `match()` in tests/library-community.
 *
 * `unique` marks a guard that targets a specific agent's own config/runtime
 * surface (its MCP wiring, its config file, its CLI verbs) — the differentiated,
 * personalized kind of guard. `unique: false` entries are high-value general
 * destructive rules placed in an agent's pack because that agent triggers them
 * often; they are honestly general, not agent-specific.
 */
export interface LibraryEntry {
  bucket: "general" | "codex" | "claude" | "hermes";
  unique: boolean;
  guard: Guard;
  vector: GuardTestVector;
}

const DATE = "2026-07-20";
const ALL: GuardAgent[] = ["claude-code", "codex", "hermes", "openclaw"];

function shell(o: {
  id: string;
  bucket: LibraryEntry["bucket"];
  unique?: boolean;
  binds: GuardAgent[];
  source: string;
  incident: string;
  cls?: "A" | "B";
  command: string;
  argsContains?: string[];
  argsAnyOf?: string[];
  action?: "block" | "warn" | "require-confirm";
  confidence?: "high" | "low";
  message: string;
  pos: string;
  neg: string;
}): LibraryEntry {
  const action = o.action ?? "block";
  const override = action === "warn" ? `vibebloat disable ${o.id}` : `vibebloat allow ${o.id} --once`;
  const match: Guard["match"] = { chokepoint: "shell", command: o.command };
  if (o.argsContains) match.argsContains = o.argsContains;
  if (o.argsAnyOf) match.argsAnyOf = o.argsAnyOf;
  return {
    bucket: o.bucket,
    unique: o.unique ?? false,
    guard: {
      schemaVersion: 1,
      id: o.id,
      class: o.cls ?? (action === "block" ? "A" : "B"),
      provenance: { incident: o.incident, date: DATE, source: o.source },
      match,
      action: { type: action, message: o.message, override },
      confidence: o.confidence ?? "high",
      tier: "community",
      binds: o.binds,
      enabled: true,
    },
    vector: {
      positive: { chokepoint: "shell", command: o.pos },
      negative: { chokepoint: "shell", command: o.neg },
    },
  };
}

function file(o: {
  id: string;
  bucket: LibraryEntry["bucket"];
  unique?: boolean;
  binds: GuardAgent[];
  source: string;
  incident: string;
  path: string;
  action?: "block" | "warn" | "require-confirm";
  confidence?: "high" | "low";
  message: string;
  posPath: string;
  negPath: string;
}): LibraryEntry {
  const action = o.action ?? "require-confirm";
  const override = action === "warn" ? `vibebloat disable ${o.id}` : `vibebloat allow ${o.id} --once`;
  return {
    bucket: o.bucket,
    unique: o.unique ?? false,
    guard: {
      schemaVersion: 1,
      id: o.id,
      class: "B",
      provenance: { incident: o.incident, date: DATE, source: o.source },
      match: { chokepoint: "file", path: o.path },
      action: { type: action, message: o.message, override },
      confidence: o.confidence ?? "high",
      tier: "community",
      binds: o.binds,
      enabled: true,
    },
    vector: {
      positive: { chokepoint: "file", path: o.posPath },
      negative: { chokepoint: "file", path: o.negPath },
    },
  };
}

const entries: LibraryEntry[] = [
  // ---------------------------------------------------------------------------
  // GENERAL (10) — universal destructive rules every agent triggers.
  // ---------------------------------------------------------------------------
  shell({
    id: "rm-recursive-force", bucket: "general", binds: ALL, source: "common-agent",
    incident: "rm -rf deleted a directory tree that was not backed up",
    command: "rm", argsContains: ["-r", "-f"],
    message: "rm -rf deletes recursively with no undo. Inspect the target, or move it aside instead of deleting.",
    pos: "rm -rf build", neg: "rm notes.txt",
  }),
  shell({
    id: "git-push-force", bucket: "general", binds: ALL, source: "common-agent",
    incident: "git push --force overwrote a teammate's pushed commits",
    command: "git push", argsAnyOf: ["-f", "--force"],
    message: "git push --force rewrites remote history and can drop others' commits. Use --force-with-lease.",
    pos: "git push -f origin main", neg: "git push --force-with-lease origin main",
  }),
  shell({
    id: "git-reset-hard", bucket: "general", binds: ALL, source: "common-agent",
    incident: "git reset --hard destroyed uncommitted work",
    command: "git reset", argsContains: ["--hard"],
    message: "git reset --hard discards uncommitted changes. Stash first, or use --soft to keep them staged.",
    pos: "git reset --hard HEAD~1", neg: "git reset --soft HEAD~1",
  }),
  shell({
    id: "git-clean-force", bucket: "general", binds: ALL, source: "common-agent",
    incident: "git clean -fd removed untracked files that were never recovered",
    command: "git clean", argsAnyOf: ["-f", "-fd", "-df", "--force"],
    message: "git clean -f deletes untracked files permanently. Preview with git clean -n first.",
    pos: "git clean -fd", neg: "git clean -n",
  }),
  shell({
    id: "git-checkout-discard", bucket: "general", binds: ALL, source: "common-agent",
    incident: "git checkout . discarded every uncommitted edit in the tree",
    command: "git checkout", argsAnyOf: ["--", "."],
    message: "git checkout . discards all uncommitted edits. Scope it to a path, or stash first.",
    pos: "git checkout .", neg: "git checkout -b feature",
  }),
  shell({
    id: "chmod-recursive-777", bucket: "general", binds: ALL, source: "common-agent",
    incident: "chmod -R 777 made a tree world-writable",
    command: "chmod", argsContains: ["-R", "777"], action: "warn",
    message: "chmod -R 777 makes everything world-writable. Grant the narrowest mode that works.",
    pos: "chmod -R 777 dist", neg: "chmod 644 app.ts",
  }),
  shell({
    id: "git-branch-force-delete", bucket: "general", binds: ALL, source: "common-agent",
    incident: "git branch -D deleted an unmerged branch with unique work",
    command: "git branch", argsAnyOf: ["-D"], action: "warn",
    message: "git branch -D force-deletes even unmerged branches. Use -d to delete only merged ones.",
    pos: "git branch -D feature", neg: "git branch -d merged-feature",
  }),
  shell({
    id: "docker-compose-down-volumes", bucket: "general", binds: ALL, source: "common-agent",
    incident: "docker compose down -v destroyed a dev database volume with seeded data",
    command: "docker compose", argsAnyOf: ["-v", "--volumes"],
    message: "docker compose down -v deletes named volumes and their data. Run without -v to keep volumes.",
    pos: "docker compose down -v", neg: "docker compose down",
  }),
  shell({
    id: "docker-system-prune-all", bucket: "general", binds: ALL, source: "common-agent",
    incident: "docker system prune -a --volumes wiped images and volumes still in use",
    command: "docker system", argsContains: ["prune"], argsAnyOf: ["-a", "--all", "--volumes"], action: "warn",
    message: "docker system prune -a --volumes removes all unused images and volumes. Confirm nothing needed is idle.",
    pos: "docker system prune -a --volumes", neg: "docker system df",
  }),
  shell({
    id: "git-stash-untracked", bucket: "general", binds: ALL, source: "common-agent",
    incident: "git stash -u swept away untracked working files that were still needed",
    command: "git stash", argsAnyOf: ["-u", "--include-untracked", "-a", "--all"],
    message: "git stash -u stashes and removes untracked files. Scope it: git stash -u -- <path>, or commit first.",
    pos: "git stash -u", neg: "git stash -u -- src/app.ts",
  }),

  // ---------------------------------------------------------------------------
  // CODEX (20) — Codex config/runtime surface + destructive rules Codex hits.
  // ---------------------------------------------------------------------------
  file({
    id: "codex-mcp-config-wrong-file", bucket: "codex", unique: true, binds: ["codex"], source: "codex-runtime",
    incident: "MCP config written to .mcp.json loaded zero servers; Codex reads mcp_servers from its own config.toml",
    path: ".mcp.json", action: "require-confirm",
    message: "Codex loads MCP servers from its config.toml [mcp_servers], not .mcp.json. This file will load zero servers.",
    posPath: ".mcp.json", negPath: ".gitignore",
  }),
  file({
    id: "codex-agents-managed-block-edit", bucket: "codex", unique: true, binds: ["codex"], source: "codex-runtime",
    incident: "hand-edits to the managed block in AGENTS.md were overwritten on the next sync",
    path: "AGENTS.md", action: "warn",
    message: "AGENTS.md has a sync-managed block that gets overwritten. Edit the source rule, not this file.",
    posPath: "AGENTS.md", negPath: "README.md",
  }),
  file({
    id: "codex-config-toml-mcp-edit", bucket: "codex", unique: true, binds: ["codex"], source: "codex-runtime",
    incident: "editing config.toml broke the hand-tuned mcp_servers block and the SessionStart hook",
    path: "config.toml", action: "require-confirm",
    message: "Codex config.toml holds hand-tuned mcp_servers and hooks. Confirm before changing — a typo drops all MCP tools.",
    posPath: "config.toml", negPath: "package.json",
  }),
  shell({
    id: "codex-google-genai-banned", bucket: "codex", unique: true, binds: ["codex", "hermes"], source: "codex-runtime",
    incident: "a banned Gemini/google-genai provider leaked back into the environment",
    command: "pip", argsAnyOf: ["google-genai", "google-generativeai"],
    message: "google-genai is a banned provider here. Do not reintroduce it — remove the dependency.",
    pos: "pip install google-genai", neg: "pip install requests",
  }),
  shell({
    id: "codex-uv-relock", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "uv sync re-resolved a live lockfile and dragged banned packages back in",
    command: "uv", argsAnyOf: ["sync", "lock"], action: "warn",
    message: "Re-resolving a live uv.lock can drag banned deps back. Freeze-and-diff before uv sync/lock on a live env.",
    pos: "uv sync", neg: "uv run app.py",
  }),
  shell({
    id: "codex-pip-not-uv", bucket: "codex", binds: ["codex"], source: "aios-policy",
    incident: "bare pip install used where uv is the required package manager",
    command: "pip", argsContains: ["install"], action: "warn",
    message: "uv is the standard here, not pip. Use uv pip install / uv add instead of bare pip install.",
    pos: "pip install flask", neg: "pip --version",
  }),
  shell({
    id: "codex-npx-yes-mcp-hang", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "npx -y as an MCP command re-resolved deps on every spawn and hung for minutes",
    command: "npx", argsAnyOf: ["-y", "--yes"], action: "warn",
    message: "npx -y re-resolves deps every spawn and can hang for minutes as an MCP command. Prefer a pinned local install.",
    pos: "npx -y some-mcp-server", neg: "npx tsc",
  }),
  shell({
    id: "codex-commit-no-verify", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git commit --no-verify skipped hooks that would have caught a broken commit",
    command: "git commit", argsAnyOf: ["--no-verify"], action: "warn",
    message: "--no-verify skips pre-commit hooks. Do not bypass them unless explicitly asked; fix the failing hook.",
    pos: "git commit --no-verify -m wip", neg: "git commit -m done",
  }),
  shell({
    id: "codex-commit-no-gpg-sign", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git commit --no-gpg-sign bypassed required commit signing",
    command: "git commit", argsAnyOf: ["--no-gpg-sign"], action: "warn",
    message: "--no-gpg-sign bypasses commit signing. Do not disable signing unless explicitly asked.",
    pos: "git commit --no-gpg-sign -m wip", neg: "git commit -m done",
  }),
  shell({
    id: "codex-git-reset-hard", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git reset --hard destroyed uncommitted work during a Codex session",
    command: "git reset", argsContains: ["--hard"],
    message: "git reset --hard discards uncommitted changes. Stash first, or use --soft to keep them staged.",
    pos: "git reset --hard origin/main", neg: "git reset --soft HEAD~1",
  }),
  shell({
    id: "codex-git-checkout-discard", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git checkout . discarded edits that existed only in the working tree",
    command: "git checkout", argsAnyOf: ["--", "."],
    message: "git checkout . discards all uncommitted edits. Scope it to a path, or stash first.",
    pos: "git checkout .", neg: "git checkout -b feature",
  }),
  shell({
    id: "codex-git-clean-force", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git clean -fd removed an untracked script the agent still needed",
    command: "git clean", argsAnyOf: ["-f", "-fd", "-df", "--force"],
    message: "git clean -f deletes untracked files permanently. Preview with git clean -n first.",
    pos: "git clean -df", neg: "git clean -nd",
  }),
  shell({
    id: "codex-rm-recursive-force", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "rm -rf removed a project subtree with no backup",
    command: "rm", argsContains: ["-r", "-f"],
    message: "rm -rf deletes recursively with no undo. Inspect the target, or move it aside instead of deleting.",
    pos: "rm -rf dist", neg: "rm scratch.txt",
  }),
  shell({
    id: "codex-git-push-force", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git push --force overwrote remote history",
    command: "git push", argsAnyOf: ["-f", "--force"],
    message: "git push --force rewrites remote history. Use --force-with-lease so you cannot clobber others' commits.",
    pos: "git push -f origin feature", neg: "git push --force-with-lease origin feature",
  }),
  file({
    id: "codex-env-file-write", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "an agent wrote to a .env secrets file",
    path: ".env", action: "require-confirm",
    message: "This writes .env, where secrets live. Confirm the change is intentional before it lands.",
    posPath: ".env", negPath: ".env.example",
  }),
  shell({
    id: "codex-git-add-all", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git add -A staged a secret file that was then committed",
    command: "git add", argsAnyOf: ["-A", "."], action: "warn",
    message: "git add -A / git add . can stage .env and other secrets. Add specific paths instead.",
    pos: "git add -A", neg: "git add src/app.ts",
  }),
  shell({
    id: "codex-curl-insecure-tls", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "curl -k disabled TLS verification and trusted a bad certificate",
    command: "curl", argsAnyOf: ["-k", "--insecure"], action: "warn",
    message: "curl -k disables TLS certificate verification. Fix the cert chain instead of trusting anything.",
    pos: "curl -k https://internal.example", neg: "curl https://example.com",
  }),
  shell({
    id: "codex-git-branch-force-delete", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git branch -D dropped an unmerged branch with unique work",
    command: "git branch", argsAnyOf: ["-D"], action: "warn",
    message: "git branch -D force-deletes unmerged branches. Use -d to delete only merged ones.",
    pos: "git branch -D wip", neg: "git branch -d merged",
  }),
  shell({
    id: "codex-npm-global-install", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "npm install -g polluted the global prefix and shadowed a pinned tool",
    command: "npm", argsContains: ["-g"], argsAnyOf: ["install", "i", "add"], action: "warn",
    message: "npm install -g mutates the global prefix and can shadow pinned tools. Prefer a project-local install.",
    pos: "npm install -g typescript", neg: "npm install typescript",
  }),
  shell({
    id: "codex-git-checkout-force", bucket: "codex", binds: ["codex"], source: "codex-runtime",
    incident: "git checkout -f overwrote unstaged edits from a parallel session in a shared tree",
    command: "git checkout", argsAnyOf: ["-f", "--force"], action: "warn",
    message: "git checkout -f overwrites unstaged work — including a parallel agent's. Stash, or use a worktree per agent.",
    pos: "git checkout -f main", neg: "git checkout -b topic",
  }),

  // ---------------------------------------------------------------------------
  // CLAUDE CODE (10) — Claude Code config surface + rules it triggers.
  // ---------------------------------------------------------------------------
  file({
    id: "claude-mcp-config-wrong-file", bucket: "claude", unique: true, binds: ["claude-code"], source: "claude-code-runtime",
    incident: "MCP servers put in .mcp.json loaded zero tools; this setup loads them from .claude.json",
    path: ".mcp.json", action: "require-confirm",
    message: "On this setup Claude Code loads MCP servers from .claude.json, not .mcp.json. This file may load zero servers.",
    posPath: ".mcp.json", negPath: ".claude.json",
  }),
  file({
    id: "claude-settings-hook-lockout", bucket: "claude", unique: true, binds: ["claude-code"], source: "claude-code-runtime",
    incident: "a broken hook in settings.json blocked Bash and Read and locked the session out of self-repair",
    path: "settings.json", action: "require-confirm",
    message: "A malformed hook in settings.json can block Bash/Read and lock the session out. Confirm the hook JSON is valid.",
    posPath: "settings.json", negPath: "tsconfig.json",
  }),
  file({
    id: "claude-settings-local-broad-permission", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "a wildcard allow-rule in settings.local.json over-permitted an agent",
    path: "settings.local.json", action: "warn",
    message: "settings.local.json controls permissions. A wildcard allow grants more than intended — scope each rule.",
    posPath: "settings.local.json", negPath: "settings.json",
  }),
  shell({
    id: "claude-commit-no-verify", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "git commit --no-verify skipped hooks that would have blocked a bad commit",
    command: "git commit", argsAnyOf: ["--no-verify"], action: "warn",
    message: "--no-verify skips pre-commit hooks. Do not bypass them unless explicitly asked; fix the failing hook.",
    pos: "git commit --no-verify -m wip", neg: "git commit -m done",
  }),
  shell({
    id: "claude-checkout-force-shared-tree", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "git checkout -f in a shared live tree reverted a parallel agent's in-progress work",
    command: "git checkout", argsAnyOf: ["-f", "--force"], action: "warn",
    message: "git checkout -f overwrites unstaged work, including a parallel session's. Use a dedicated worktree per agent.",
    pos: "git checkout -f main", neg: "git checkout -b topic",
  }),
  shell({
    id: "claude-remove-config-dir", bucket: "claude", unique: true, binds: ["claude-code"], source: "claude-code-runtime",
    incident: "rm -rf on the .claude config dir wiped multi-account junctions and settings",
    command: "rm", argsContains: ["-r"], argsAnyOf: [".claude"],
    message: "Removing the .claude directory wipes account junctions and settings. Back it up before deleting.",
    pos: "rm -rf .claude", neg: "rm -rf .cache",
  }),
  file({
    id: "claude-md-import-edit", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "an edit to CLAUDE.md broke an @path import and silently dropped instructions",
    path: "CLAUDE.md", action: "warn", confidence: "low",
    message: "CLAUDE.md may use @path imports. A broken path silently drops those instructions — verify imports resolve.",
    posPath: "CLAUDE.md", negPath: "NOTES.md",
  }),
  shell({
    id: "claude-git-add-all", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "git add -A staged a secret file that reached a commit",
    command: "git add", argsAnyOf: ["-A", "."], action: "warn",
    message: "git add -A / git add . can stage .env and other secrets. Add specific paths instead.",
    pos: "git add .", neg: "git add src/app.ts",
  }),
  shell({
    id: "claude-git-restore-discard", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "git restore . discarded every unstaged edit in the tree",
    command: "git restore", argsAnyOf: ["."],
    message: "git restore . discards all unstaged edits. Scope it to a path, or use --staged deliberately.",
    pos: "git restore .", neg: "git restore --staged app.ts",
  }),
  shell({
    id: "claude-npx-yes-mcp-hang", bucket: "claude", binds: ["claude-code"], source: "claude-code-runtime",
    incident: "npx -y as an MCP command re-resolved deps every spawn and hung the session",
    command: "npx", argsAnyOf: ["-y", "--yes"], action: "warn",
    message: "npx -y re-resolves deps every spawn and can hang as an MCP command. Prefer a pinned local install.",
    pos: "npx -y some-mcp-server", neg: "npx tsc",
  }),

  // ---------------------------------------------------------------------------
  // HERMES (10) — fleet/gateway runtime surface + rules it triggers.
  // ---------------------------------------------------------------------------
  shell({
    id: "hermes-force-kill-gateway", bucket: "hermes", unique: true, binds: ["hermes"], source: "hermes-fleet",
    incident: "force-killing the gateway process only made it respawn; a graceful stop is required",
    command: "pkill", argsAnyOf: ["hermes"], action: "warn",
    message: "Force-killing a Hermes gateway makes it respawn. Stop it gracefully with hermes gateway stop --all.",
    pos: "pkill -f hermes", neg: "pkill -f other-daemon",
  }),
  shell({
    id: "hermes-uv-relock", bucket: "hermes", unique: true, binds: ["hermes"], source: "hermes-fleet",
    incident: "uv sync re-resolved the Hermes lockfile and dragged a banned provider back in",
    command: "uv", argsAnyOf: ["sync", "lock"], action: "warn",
    message: "Re-resolving Hermes's uv.lock can drag banned deps back. Freeze-and-diff before uv sync/lock on this env.",
    pos: "uv sync", neg: "uv run agent.py",
  }),
  shell({
    id: "hermes-npx-yes-mcp-hang", bucket: "hermes", binds: ["hermes"], source: "hermes-fleet",
    incident: "npx -y / uvx as an MCP command re-resolved on every spawn; the fleet loaded 0 tools for minutes",
    command: "npx", argsAnyOf: ["-y", "--yes"], action: "warn",
    message: "npx -y re-resolves every spawn and stalls fleet load. Point the MCP config at a pinned installed binary.",
    pos: "npx -y mcp-server", neg: "npx eslint",
  }),
  shell({
    id: "hermes-gateway-restart", bucket: "hermes", unique: true, binds: ["hermes"], source: "hermes-fleet",
    incident: "hermes gateway restart stopped the gateway without starting it back up",
    command: "hermes", argsContains: ["gateway", "restart"], action: "warn",
    message: "hermes gateway restart stops without starting. Use gateway stop then start the scheduled task, not restart.",
    pos: "hermes gateway restart", neg: "hermes gateway stop",
  }),
  shell({
    id: "hermes-update-reverts-patch", bucket: "hermes", unique: true, binds: ["hermes"], source: "hermes-fleet",
    incident: "hermes update reverted a local gateway patch that upstream had not merged",
    command: "hermes", argsContains: ["update"], action: "warn",
    message: "hermes update can revert local patches upstream hasn't merged (e.g. the fsync fix). Diff before updating.",
    pos: "hermes update", neg: "hermes gateway status",
  }),
  shell({
    id: "hermes-stash-untracked-live-tree", bucket: "hermes", binds: ["hermes"], source: "hermes-fleet",
    incident: "git stash -u in the shared live tree removed operational untracked launcher scripts",
    command: "git stash", argsAnyOf: ["-u", "--include-untracked", "-a", "--all"],
    message: "In the live Hermes tree, untracked files are operational. git stash -u deletes them — scope with -- <path>.",
    pos: "git stash -u", neg: "git stash -u -- src/agent.py",
  }),
  shell({
    id: "hermes-checkout-force-shared-tree", bucket: "hermes", binds: ["hermes"], source: "hermes-fleet",
    incident: "git checkout -f in the shared tree reverted a running gateway's in-process patch",
    command: "git checkout", argsAnyOf: ["-f", "--force"], action: "warn",
    message: "git checkout -f in the shared tree can revert a running gateway's live patch. Use a worktree per task.",
    pos: "git checkout -f main", neg: "git checkout -b hotfix",
  }),
  file({
    id: "hermes-config-yaml-no-hot-reload", bucket: "hermes", unique: true, binds: ["hermes"], source: "hermes-fleet",
    incident: "MCP defs edited in config.yaml did nothing because they do not hot-reload",
    path: "config.yaml", action: "warn", confidence: "low",
    message: "Hermes MCP defs in config.yaml do not hot-reload. Restart the gateway for changes here to take effect.",
    posPath: "config.yaml", negPath: "package.json",
  }),
  shell({
    id: "hermes-pip-not-uv", bucket: "hermes", binds: ["hermes"], source: "aios-policy",
    incident: "bare pip install used in a Hermes env that is managed by uv",
    command: "pip", argsContains: ["install"], action: "warn",
    message: "Hermes uses uv, not pip. Bare pip install desyncs the lock — use uv add / uv pip install.",
    pos: "pip install httpx", neg: "pip --version",
  }),
  shell({
    id: "hermes-google-genai-banned", bucket: "hermes", unique: true, binds: ["hermes"], source: "hermes-fleet",
    incident: "a banned Gemini/google-genai provider was re-added to the fleet dependencies",
    command: "uv", argsAnyOf: ["google-genai", "google-generativeai"],
    message: "google-genai is a banned provider in the fleet. Do not reintroduce it.",
    pos: "uv add google-genai", neg: "uv add httpx",
  }),
];

export function libraryEntries(): LibraryEntry[] {
  return entries;
}

export function communityGuards(): Guard[] {
  return entries.map((entry) => entry.guard);
}

export function communityGuardsForAgent(agent: GuardAgent): Guard[] {
  return entries
    .filter((entry) => entry.guard.binds?.includes(agent))
    .map((entry) => entry.guard);
}
