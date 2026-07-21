# Controlled Update Contract

`vibebloat update` is wired to package-local controlled release assets. This checkout
deliberately lacks a signed artifact, signature bundles, community manifest, and pinned
public key, so its command stops at the trust check rather than claiming an available
release.

When a complete controlled release supplies those assets, the following shipped path
applies.

## Preview

`vibebloat update` verifies the candidate before printing a non-mutating six-line diff:

```text
VibeBloat update available: <current> -> <candidate>
Guards: <N> added / <M> changed / <K> removed
Added: <guard-id>, ...
Changed: <guard-id> [<fields>], ...
Removed: <guard-id>, ...
Apply: vibebloat update --apply
```

Empty lists print `none`. A guard counts as changed only when `class`, `match`, `action`,
`binds`, or `enabled` differs after canonical comparison. Every changed and removed ID
is listed.

Before preview, VibeBloat requires a newer semantic version, closed release metadata,
a pinned public-key hash, Cosign verification for the candidate binary and community
manifest, valid community guards, and no collision with an installed local guard.

## Apply and rollback

`vibebloat update --apply` works only from a signed standalone executable. A
non-standalone process cannot replace itself and receives the three-line recovery path
from `ERROR-PATTERN-SPEC.md`.

On macOS and Linux, apply:

1. backs up the current binary and community-guard directory;
2. atomically replaces the binary and community guards, leaving local guards untouched;
3. runs `vibebloat doctor`;
4. deletes backups only after a healthy result; and
5. restores both backups and re-runs doctor after candidate failure.

Windows stages an external swap and reports that doctor and rollback will run after the
current process exits. Verification, diff, or validation failure occurs before installed
files change. Failed rollback preserves recovery material and returns nonzero.

Successful non-Windows apply prints current/candidate versions, guard counts,
`Doctor: healthy`, and `Rollback: not needed`. All recoverable update failures use the
three-line CLI error pattern.
