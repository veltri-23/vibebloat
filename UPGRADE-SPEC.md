# Upgrade UX Spec

## Scope

This document defines the terminal contract for T24. It does not select a release
host, package registry, download endpoint, or changelog transport. Those claims
require controlled release infrastructure that is not present in this repository.

An update may change the VibeBloat binary and bundled community guards. Local
guards are user-owned and must never be added, changed, or removed by an update.

## Pre-Update Diff

Every manual or opt-in automatic update must produce a diff before it changes
installed behavior. The summary uses exact counts:

`vibebloat update` performs this check and preview without mutating installed
files.

```text
VibeBloat update available: <current> -> <candidate>
Guards: <N> added / <M> changed / <K> removed
Added: <guard-id>, ...
Changed: <guard-id> [<fields>], ...
Removed: <guard-id>, ...
Apply: vibebloat update --apply
```

- Keep all six lines. Use `none` when a list is empty.
- `added` means a community guard ID exists only in the candidate release.
- `removed` means a currently installed community guard ID is absent from the
  candidate release.
- `changed` means the same community guard ID has a different executable
  behavior: `class`, `match`, `action`, `binds`, or `enabled`.
- Provenance, confidence, and other non-executable metadata changes may appear in
  the changelog but do not increase the changed count.
- List every changed or removed guard. Do not hide behavior changes behind a
  total or changelog link.
- Compare canonical validated guard objects, not formatted source text.
- Build the diff from the candidate manifest covered by the same controlled
  release verification as the binary. If the diff cannot be built, refuse the
  update before any write.

Example:

```text
VibeBloat update available: 0.4.0 -> 0.5.0
Guards: 2 added / 1 changed / 0 removed
Added: no-force-push, no-secret-commit
Changed: git-stash-u [match, action]
Removed: none
Apply: vibebloat update --apply
```

## One-Command Apply

`vibebloat update --apply` is the single copy-pasteable apply command. It does
not require a second confirmation. Running it directly still prints the complete
pre-update diff before mutation.

Apply order is fixed:

1. Parse release metadata and candidate guard manifest.
2. Verify relative release paths, pinned public-key fingerprint, and Cosign
   signature.
3. Validate every candidate community guard and calculate the pre-update diff.
4. Write a rollback copy of the current binary and current community guards.
5. Replace the binary and community guards. Leave local guards untouched.
6. Run `vibebloat doctor` against the candidate installation.
7. Report success only when doctor is healthy.

The success receipt is:

```text
Updated VibeBloat: <current> -> <candidate>
Guards: <N> added / <M> changed / <K> removed
Doctor: healthy
Rollback: not needed
```

## Automatic Updates

Automatic update remains opt-in. It uses the identical verification, diff,
backup, apply, doctor, and rollback path as manual apply. Before mutation, it
writes the complete diff to the local update receipt and emits the same summary
to the active terminal or agent log. Opt-in never weakens signature or doctor
gates.

## Rollback And Failure

Release metadata, signature, pinned-key, manifest, or guard-validation failure
halts before backup or mutation. A failed candidate doctor run restores the
previous binary and community guards, then runs doctor against the restored
installation. The failed candidate must never remain active after a successful
rollback.

Recoverable failures write exactly three newline-terminated stderr lines. No
emoji, stack trace, raw command, environment value, secret, or absolute path may
appear.

Verification or diff failure:

```text
WHAT failed: update was not applied.
WHY: controlled release verification or guard diff validation failed.
FIX: vibebloat update
```

Candidate doctor failure with successful rollback:

```text
WHAT failed: update health check failed.
WHY: vibebloat doctor rejected <candidate>; <current> was restored.
FIX: vibebloat doctor
```

Rollback failure:

```text
WHAT failed: update rollback failed.
WHY: doctor rejected <candidate> and <current> could not be restored.
FIX: vibebloat install --yes
```

If rollback itself fails, return nonzero and preserve the rollback copy for
recovery. Never report the candidate as installed or healthy.

## Acceptance

- Preview prints exact added, changed, and removed counts plus affected guard IDs.
- Preview exposes every executable behavior change before mutation.
- Apply uses exactly `vibebloat update --apply` and requires no second command.
- Signature and pinned-key verification happen before any installed-file write.
- Successful apply runs doctor and reports `Doctor: healthy`.
- Doctor failure restores both binary and community guards and verifies the
  restored installation.
- Local guards remain byte-for-byte unchanged.
- Failure output follows `ERROR-PATTERN-SPEC.md` and contains exactly three lines.
- Focused tests assert preview counts, direct apply, verification-before-write,
  post-update doctor, successful rollback, rollback failure, and exact stderr.

## Current Implementation Boundary

`src/updater/auto-update.ts` currently verifies release metadata and the pinned
key through Cosign before writes, backs up the binary, atomically replaces it,
runs candidate doctor, deletes the backup only on success, and atomically restores
and rechecks the prior binary when candidate doctor fails.

Update CLI commands, release discovery, candidate guard manifests, community
guard diffs, local update receipts, community-guard rollback, and three-line
updater errors are not wired yet. This specification defines their required
behavior without claiming that release infrastructure exists.
