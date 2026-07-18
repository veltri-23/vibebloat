# Install

VibeBloat is not published to npm and has no signed public binary yet. These steps
install a development checkout without claiming release provenance.

## Prerequisites

- Bun `>=1.3.0`
- Git
- Python for Hermes integration
- Controlled Presidio and Gitleaks scrubber commands before history scanning

## Source checkout

Run on Windows, macOS, or Linux:

```sh
bun install --frozen-lockfile
bun link
vibebloat install --yes
vibebloat doctor
```

The installer preserves existing Claude Code and Codex hook order. It refuses unsafe
configuration shapes instead of overwriting them.

## Hermes

Windows PowerShell:

```powershell
$hermesHome = Join-Path $env:USERPROFILE '.hermes'
$hermesPython = 'C:\absolute\path\to\python.exe'
vibebloat install --yes --hermes-home $hermesHome --hermes-python $hermesPython
```

macOS or Linux:

```sh
hermes_home="$HOME/.hermes"
hermes_python="/absolute/path/to/python3"
vibebloat install --yes --hermes-home "$hermes_home" --hermes-python "$hermes_python"
```

Start Hermes without safe mode; safe mode intentionally skips user shell hooks.

## OpenClaw

The npm package contains the `vibebloat` runtime extension for OpenClaw `>=2026.4.0`.
Load it through OpenClaw's host-managed extension flow. Do not treat an
`OPENCLAW_SESSION` environment variable as proof that the plugin is installed.

## Universal fallback

Provide absolute paths to an empty shim directory and the real Git executable:

```sh
vibebloat install --yes --fallback-shim-dir <absolute-shim-dir> --fallback-git <absolute-git-executable>
```

Place the shim directory first on PATH in fresh bash, zsh, fish, and PowerShell
sessions before installation. Missing shells or PATH drift stop fallback install.

## Verify

```sh
printf '%s' '{"tool_input":{"command":"git stash -u"}}' | vibebloat hook
```

Expected result: exit code `2` plus a four-line scrubbed block receipt. Repeat through
each installed agent before relying on a guard.
