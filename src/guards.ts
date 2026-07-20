import type { Guard } from "./types";

export const gitStashUntrackedGuardId = "git-stash-u";
export const legacyGitStashUntrackedGuardId = "git-stash-untracked";

export function canonicalGuardId(guardId: string): string {
  return guardId === legacyGitStashUntrackedGuardId ? gitStashUntrackedGuardId : guardId;
}

export function compatiblePersistedGuardIds(guardId: string): readonly string[] {
  return canonicalGuardId(guardId) === gitStashUntrackedGuardId
    ? [gitStashUntrackedGuardId, legacyGitStashUntrackedGuardId]
    : [guardId];
}

export const gitStashUntrackedGuard: Guard = {
  id: gitStashUntrackedGuardId,
  class: "A",
  provenance: {
    incident: "git stash -u deleted operational untracked files",
    date: "2026-07-15",
    source: "claude-code",
  },
  match: { chokepoint: "shell", command: "git stash", argsAnyOf: ["-u", "--include-untracked", "-a", "--all"] },
  action: {
    type: "block",
    message: "07-15 this deleted untracked files. Use git stash -u -- <path> or commit first.",
    override: "vibebloat allow git-stash-u --once",
  },
  enabled: true,
};

export const mcpConfigWrongFileGuard: Guard = {
  id: "mcp-config-wrong-file",
  class: "B",
  provenance: {
    incident: "MCP config written to the wrong file loaded zero servers",
    date: "2026-07-15",
    source: "codex",
  },
  match: { chokepoint: "file", path: ".mcp.json" },
  action: {
    type: "block",
    message: "07-15 this put MCP config in the wrong file. Use .claude.json instead.",
    override: "vibebloat allow mcp-config-wrong-file --once",
  },
  enabled: true,
};

export const gitResetHardGuard: Guard = {
  id: "git-reset-hard",
  class: "A",
  provenance: {
    incident: "git reset --hard destroyed uncommitted work",
    date: "2026-07-15",
    source: "claude-code",
  },
  match: { chokepoint: "shell", command: "git reset", argsContains: ["--hard"] },
  action: {
    type: "block",
    message: "07-15 this destroyed uncommitted work. Use git stash first, or reset --soft to keep changes staged.",
    override: "vibebloat allow git-reset-hard --once",
  },
  enabled: true,
};

export const gitCheckoutDiscardGuard: Guard = {
  id: "git-checkout-discard",
  class: "A",
  provenance: {
    incident: "git checkout -- . discarded unstaged edits from process memory",
    date: "2026-07-15",
    source: "codex",
  },
  match: { chokepoint: "shell", command: "git checkout", argsAnyOf: ["--", "."] },
  action: {
    type: "block",
    message: "07-15 this discarded edits that existed only in process memory. Use git stash first or git restore --staged selectively.",
    override: "vibebloat allow git-checkout-discard --once",
  },
  enabled: true,
};

export const gitCleanForceGuard: Guard = {
  id: "git-clean-force",
  class: "A",
  provenance: {
    incident: "git clean -fd removed an untracked script; agent went days without noticing",
    date: "2026-07-15",
    source: "claude-code",
  },
  match: { chokepoint: "shell", command: "git clean", argsAnyOf: ["-fd", "-df", "-f"] },
  action: {
    type: "block",
    message: "07-15 this removed an untracked script silently. Use git clean -nd first to preview what would be deleted.",
    override: "vibebloat allow git-clean-force --once",
  },
  enabled: true,
};

export const npxMcpHangGuard: Guard = {
  id: "npx-mcp-hang",
  class: "B",
  provenance: {
    incident: "npx/uvx used as MCP commands re-resolved deps each spawn and hung for minutes with zero output",
    date: "2026-07-15",
    source: "codex",
  },
  match: { chokepoint: "shell", command: "npx", argsAnyOf: ["-y", "--yes"] },
  action: {
    type: "warn",
    message: "07-15 this hung the agent for minutes. Prefer pinned local installs over npx -y for MCP server commands.",
    override: "vibebloat disable npx-mcp-hang",
  },
  enabled: true,
};

export const gitCheckoutParallelRevertGuard: Guard = {
  id: "git-checkout-parallel-revert",
  class: "A",
  provenance: {
    incident: "running `git checkout -- .` while a parallel agent reverts in the same worktree wiped both branches' work — checkout discards unstaged, not just the parallel branch",
    date: "2026-07-15",
    source: "claude-code",
  },
  match: { chokepoint: "shell", command: "git checkout", argsAnyOf: ["--", "-f", "--force"] },
  action: {
    type: "warn",
    message: "07-15 this overwrote unstaged work from a parallel session. Use git stash or a dedicated worktree per agent.",
    override: "vibebloat disable git-checkout-parallel-revert",
  },
  enabled: true,
};
