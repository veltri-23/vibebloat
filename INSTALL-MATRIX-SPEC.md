# Install Matrix

> Build scaffold, not release instructions. The package is private at
> `0.0.0-spike`; no published package, signed binary, or automatic updater is
> available yet.

## Common prerequisites

- Bun `>=1.3.0` for a source checkout.
- `vibebloat` must resolve on every agent process PATH; installed hooks run
  `vibebloat hook`.
- Explicit permission is required: `vibebloat install --yes`.
- Keep existing agent configuration valid. The installer refuses unsafe Hermes
  config shapes instead of overwriting them.
- VibeBloat runs first in supported PreToolUse and Git-hook chains, then leaves
  every pre-existing hook in its original relative order.

## Native agents

| Agent | Path convention | Prerequisite | Verify |
|---|---|---|---|
| Claude Code | Windows: `%USERPROFILE%\\.claude\\settings.json`; macOS/Linux: `~/.claude/settings.json` | Override root with `CLAUDE_CONFIG_DIR` when needed. | Config contains `vibebloat hook`. |
| Codex | Windows: `%USERPROFILE%\\.codex\\config.toml`; macOS/Linux: `~/.codex/config.toml` | Override root with `CODEX_HOME` when needed. | Config contains `plugin_hooks = true` and `vibebloat hook --agent=codex`. |
| OpenClaw | Host-managed extension path | OpenClaw `>=2026.4.0`; install/load this package through the host's supported extension flow. | Host reports plugin id `vibebloat` registered for `before_tool_call`. |

The current CLI configures Claude Code and Codex with:

```
vibebloat install --yes
```

For Claude Code and Codex, the installer inserts the VibeBloat PreToolUse entry
before existing entries. Re-running install is idempotent and does not reorder the
remaining chain. Fallback Git hooks keep the shebang first, then VibeBloat, then
the original hook body. OpenClaw extension order is host-owned; installation must
not claim first position unless the host reports it.

OpenClaw has a packaged runtime extension but no separate CLI install flag yet.
Do not claim it is installed until the host loads the extension.

## Hermes

Hermes installation accepts only its canonical home plus an explicit Python
interpreter. It writes only under that home:

```
<hermes-home>/config.yaml
<hermes-home>/hooks/vibebloat/{HOOK.yaml,handler.py}
<hermes-home>/shell-hooks-allowlist.json
```

`--hermes-home` must be an existing absolute directory. `--hermes-python` must
be an existing absolute Python executable. The exact interpreter path is pinned
in the Hermes hook command and allowlist entry.

Windows PowerShell:

```
$hermesHome = Join-Path $env:USERPROFILE '.hermes'
$hermesPython = 'C:\\absolute\\path\\to\\python.exe'
vibebloat install --yes --hermes-home $hermesHome --hermes-python $hermesPython
```

macOS/Linux:

```
hermes_home="$HOME/.hermes"
hermes_python="/absolute/path/to/python3"
vibebloat install --yes --hermes-home "$hermes_home" --hermes-python "$hermes_python"
```

Do not use the retired `--hermes-hooks-dir` or `--hermes-config` flags. Verify
the three canonical files exist, then start Hermes without safe mode; Hermes
safe mode deliberately skips all user shell hooks.

## Fallback git shim

The optional fallback needs both absolute paths:

```
vibebloat install --yes --fallback-shim-dir <absolute-shim-dir> --fallback-git <absolute-git-executable>
```

Current installer verifies the shim directory before writing the shim. Prepare
that directory and place it first on PATH in fresh `bash`, `zsh`, `fish`, and
PowerShell sessions before invoking the command; a missing shell or a later PATH
entry stops the fallback install. After install, `command -v git` (POSIX) or
`Get-Command git` (PowerShell) must resolve from the shim directory.

## Verification

`vibebloat doctor` checks the Claude/Codex hook entries and a runner-written
proof marker. It does not currently attest OpenClaw, Hermes, or fallback PATH.
For a source checkout, verify the shared hook directly:

```
printf '%s' '{"tool_input":{"command":"git stash -u"}}' | bun src/cli.ts hook
```

Expected result: exit code `2` and a VibeBloat block message. Repeat through
each installed agent before relying on a guard.
