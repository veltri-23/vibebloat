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
