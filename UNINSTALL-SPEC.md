# Clean Uninstall Contract

```text
vibebloat uninstall --yes [--keep-data]
```

`--yes` is mandatory. `--keep-data` removes integrations while preserving machine and
repository VibeBloat data.

## Ownership boundary

Uninstall removes only artifacts it can prove VibeBloat owns. Missing artifacts are
success; malformed or ambiguous host configuration fails before mutation.

The CLI removes:

- the exact `vibebloat hook` Claude Code entry;
- the exact `vibebloat hook --agent=codex` Codex block;
- the marked Hermes bridge, matching allowlist entry, and Hermes VibeBloat hook
  directory;
- marked VibeBloat blocks in current-repository Git hooks; and
- fallback `git` shims only when explicit absolute paths, ownership markers, and the
  recorded real-Git target match.

The uninstall library can unregister OpenClaw when a host supplies its extension
lifecycle. The CLI does not invent or delete a host extension directory.

All unrelated hooks, settings, approvals, files, parent directories, runtimes, package
managers, agent applications, and projects remain untouched.

## Data and repository handling

Without `--keep-data`, uninstall stages VibeBloat machine data under the resolved global
home for deletion, including guards, proofs, overrides, compile state, receipts, audit,
cache, onboarding, and disabled-guard state. It removes an untracked current-repository
`.vibebloat/` directory but preserves every tracked path and reports it.

## Transaction and recovery

The CLI stops an exact receipt-bound filesystem guard before uninstall. Shared config
files are snapshotted beside their originals, written atomically, and verified before
staged artifacts are deleted. Verification requires native configs and owned artifacts
to be clean and doctor to report `not-installed`.

Any mutation or verification failure restores shared configs and staged artifacts. If
the CLI stopped a filesystem guard, it restarts it after rollback. Cleanup failure after
a verified uninstall returns a three-line error without pretending cleanup succeeded.
