# Clean Uninstall

Status: T31 contract. CLI implementation remains separate.

## Command

```text
vibebloat uninstall --yes
```

`--yes` is mandatory because uninstall changes native agent configuration and
removes local runtime data. `--keep-data` preserves guard homes and audit data
while still removing integrations.

## Ownership rule

Remove only artifacts VibeBloat can prove it owns. Missing artifacts are success.
Malformed host configuration fails closed before mutation. Every changed shared
config file uses same-directory temporary write plus atomic rename.

## Integrations removed

- Claude Code: remove only `PreToolUse` hook entries whose command is exactly
  `vibebloat hook`. Preserve other hooks, matchers, and settings.
- Codex: remove only the `[[hooks.PreToolUse]]` block whose hook command is exactly
  `vibebloat hook --agent=codex`. Preserve `[features]`, `plugin_hooks`, and all
  other hook blocks.
- Hermes: remove the bridge beginning with
  `# vibebloat-hermes-pre-tool-call`, its exact matching allowlist approval, and
  `<hermes-home>/hooks/vibebloat/`. Preserve every other hook, approval, and
  configuration value.
- OpenClaw: unregister packaged plugin id `vibebloat` through OpenClaw's extension
  lifecycle when the host exposes it. Never delete the host's extension directory.
- Fallback shell shim: remove generated `git` and `git.cmd` only when their
  VibeBloat ownership marker and recorded real-git target match. Preserve the shim
  directory and unrelated files.
- Git hooks: remove only VibeBloat's marked command block. Preserve user hook code.

## Local data removed

Without `--keep-data`, remove VibeBloat-owned machine data under the resolved
global VibeBloat home: installed guards, proofs, overrides, onboarding state,
compile queue/checkpoints, receipts, audit events, and VibeBloat-created empty
directories.

Repository `.vibebloat/` directories may be git-backed user data. Remove an
untracked current-repository directory only after `--yes`; never delete a tracked
file. Report tracked paths as preserved so the repository owner can remove them
through normal version control.

Do not remove the package manager, Bun, Python, git, agent applications, user
projects, or generic parent directories.

## Transaction and recovery

1. Preflight every selected integration and classify each target as owned,
   absent, preserved, or unsafe.
2. Stop before mutation if any target is unsafe.
3. Snapshot shared config files beside the originals.
4. Remove owned integration entries, then owned standalone artifacts, then local
   data.
5. Run uninstall verification. On failure, restore shared configs from snapshots
   and print WHAT / WHY / FIX.
6. Delete snapshots only after verification passes.

Verification passes when native configs contain no VibeBloat command, Hermes has
no VibeBloat bridge or allowlist approval, owned shims/hooks are absent, and
`vibebloat doctor` reports not installed rather than unhealthy.

## Acceptance checks

- Repeated uninstall succeeds without changing unrelated files.
- Shared Claude, Codex, Hermes, shell, and git-hook fixtures retain all non-
  VibeBloat entries byte-for-byte where possible.
- Unsafe or malformed host config causes zero writes.
- Default uninstall removes 30-day audit data; `--keep-data` preserves it.
- Tracked repository guards are reported and preserved.
