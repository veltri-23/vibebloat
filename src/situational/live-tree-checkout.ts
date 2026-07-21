import type { Guard } from "../types";

export { gatherEventContext } from "./context";

/**
 * A situational, self-learned guard.
 *
 * Not "git checkout -f is bad" (a command-class blocklist). This fires only on
 * the recurrence of ONE specific mistake: force-checkout inside the shared
 * hermes tree, while a gateway process is live, with unstaged changes present.
 * That exact combination once reverted a patch that existed only in the running
 * gateway's memory. Anywhere else -- another repo, no gateway, a clean tree --
 * the same command runs untouched.
 */
export const hermesLiveTreeCheckoutGuard: Guard = {
  schemaVersion: 1,
  id: "hermes-force-checkout-live-tree",
  class: "A",
  provenance: {
    incident:
      "git checkout -f in the shared hermes tree while a gateway was live reverted the fsync patch that existed only in the running process's memory, costing ~8,590 blocked Discord heartbeats on 2026-07-10",
    date: "2026-07-10",
    source: "hermes-fleet",
  },
  match: {
    chokepoint: "shell",
    command: "git checkout",
    argsAnyOf: ["-f", "--force"],
    context: {
      cwdUnder: "D:/AI/hermes",
      whenProcessRunning: "hermes",
      whenUnstagedChanges: true,
    },
  },
  action: {
    type: "block",
    message:
      "07-10 force-checkout here reverted a running gateway's in-memory fsync patch and cost ~8,590 blocked heartbeats. A gateway is live and you have unstaged changes right now. Stash first or use a worktree -- this command is fine anywhere else.",
    override: "vibebloat allow hermes-force-checkout-live-tree --once",
  },
  confidence: "high",
  tier: "local",
  binds: ["hermes"],
  enabled: true,
};
