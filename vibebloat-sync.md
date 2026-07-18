# Git-Backed Guard Sync

Multi-machine sync uses the user's existing Git remote. VibeBloat adds no sync
service, account, telemetry channel, or hidden network destination.

## Tracked surface

Only repository-scoped declarative guards under `.vibebloat/guards/` sync. These
stay repository data and use the schema in `src/types.ts` plus validation in
`src/schema.ts`.

Never sync:

- transcripts, incident quotes, raw commands, secrets, or absolute paths;
- machine guards, overrides, firing/audit logs, checkpoints, email, or receipts;
- hook configuration, executables, release keys, or updater backups.

## Pull contract

`vibebloat sync --pull` may use only the current repository's configured Git remote
and checked-out branch. It must:

1. Refuse outside a Git worktree or when no upstream is configured.
2. Fetch without changing tracked files.
3. Require a fast-forward update; never merge, rebase, force, or resolve conflicts.
4. Preview added, changed, and removed guard IDs.
5. Validate every candidate guard before changing the active guard directory.
6. Apply the validated fast-forward, reload guards, then run `vibebloat doctor`.
7. Restore the previous active guard snapshot if validation, reload, or doctor fails.

No automatic commit or push. User-owned Git tooling handles authorship and review.
Background pull is opt-in and follows the same validation and rollback path.

## Conflicts

Dirty `.vibebloat/guards/`, divergent history, invalid guards, missing upstream, or
doctor failure stops sync. Output follows `ERROR-PATTERN-SPEC.md`; the fix command is
one explicit Git or VibeBloat command. Unrelated dirty repository files do not block
a fast-forward unless Git itself would overwrite them.

## Acceptance

- Two clones using the same upstream load the same repository guards after pull.
- No machine-local state appears in `git status` because of sync.
- Invalid remote guards never become active.
- Divergence and conflicts never trigger an automatic merge, rebase, force, or push.
- Network traffic targets only the user-configured Git remote.
