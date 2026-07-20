import type { IncidentManifest } from "../ingest/rank";
import type { HistoryChunk } from "../ingest/types";

/**
 * A synthetic corpus so someone with no agent history can still watch the real
 * loop run: scrub, prefilter, mine, compile, install, block.
 *
 * Every session id says "sample" and the label is printed at every step. The
 * one thing this must never do is let a reader mistake these findings for
 * their own — the entire product rests on the numbers being theirs.
 *
 * The content is invented. It mirrors incident shapes documented in
 * PROJECT-SEED.md, but no line is a real transcript excerpt.
 */
export const SAMPLE_LABEL = "SAMPLE DATA — invented history, not yours";

export function sampleHistory(): HistoryChunk[] {
  return [
    {
      source: "claude-code", sessionId: "sample-session-1", messageIndex: 0, chunkIndex: 0, role: "user",
      content: "wait, why did you run git stash -u? that deleted the launcher scripts I had not committed yet",
    },
    {
      source: "claude-code", sessionId: "sample-session-1", messageIndex: 1, chunkIndex: 0, role: "assistant",
      content: "[tool] git stash -u\nStashed working directory and untracked files.",
    },
    {
      source: "claude-code", sessionId: "sample-session-2", messageIndex: 0, chunkIndex: 0, role: "user",
      content: "git stash -u wiped my untracked files again. stop doing that, I lose work every time",
    },
    {
      source: "codex", sessionId: "sample-session-3", messageIndex: 0, chunkIndex: 0, role: "user",
      content: "the whole local database is gone. docker compose down -v destroyed the volume, that was seeded data",
    },
    {
      source: "codex", sessionId: "sample-session-4", messageIndex: 0, chunkIndex: 0, role: "user",
      content: "docker compose down -v again? that is the second time the dev database got dropped this week",
    },
    {
      source: "claude-code", sessionId: "sample-session-5", messageIndex: 0, chunkIndex: 0, role: "user",
      content: "the MCP config was written to the wrong file so zero servers loaded and nothing reported an error. broken for two days",
    },
    {
      source: "hermes", sessionId: "sample-session-6", messageIndex: 0, chunkIndex: 0, role: "user",
      content: "you keep putting server config in .mcp.json when this tool reads .claude.json. it fails silently every single time",
    },
  ];
}

/**
 * What a model finds in the corpus above.
 *
 * Used only when no model is configured, so the demo still runs offline. The
 * caller must say plainly that these are precomputed — presenting them as a
 * live result would be the same lie as showing someone else's numbers.
 */
export function samplePrecomputedIncidents(): IncidentManifest[] {
  return [
    {
      incident_id: "sample-git-stash-untracked",
      class: "A",
      chokepoint: "shell",
      command: "git stash",
      args_contains: ["-u"],
      condition: "git stash -u stashed untracked files that were never recovered",
      remediation: "Scope it with git stash -u -- <path>, or commit the files first.",
      evidence_refs: ["sample-session-1:0", "sample-session-2:0"],
      severity: 5,
      frequency: 2,
      recency: "2026-07-15",
    },
    {
      incident_id: "sample-docker-compose-volumes",
      class: "A",
      chokepoint: "shell",
      command: "docker compose",
      args_contains: ["down", "-v"],
      condition: "docker compose down -v destroyed the seeded local database volume",
      remediation: "Drop the -v flag, or snapshot the volume before tearing down.",
      evidence_refs: ["sample-session-3:0", "sample-session-4:0"],
      severity: 5,
      frequency: 2,
      recency: "2026-07-16",
    },
    {
      incident_id: "sample-mcp-config-wrong-file",
      class: "B",
      chokepoint: "file",
      path: ".mcp.json",
      condition: "MCP servers written to .mcp.json load silently as zero servers",
      remediation: "Check which config file this tool reads before writing server entries.",
      evidence_refs: ["sample-session-5:0", "sample-session-6:0"],
      severity: 4,
      frequency: 2,
      recency: "2026-07-13",
    },
  ];
}
