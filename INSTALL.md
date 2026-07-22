# Install

VibeBloat is not published to npm and has no signed public binary yet. These steps
install a development checkout without claiming release provenance.

## Prerequisites

- Bun `>=1.3.0`
- Git
- Python for Hermes integration
- No external scrubber needed: a source checkout uses the built-in in-process
  scrubber. Controlled Presidio and Gitleaks commands are used only by a signed release.

## Source checkout

Run on Windows, macOS, or Linux. The recommended installation goes through
personalized onboarding so history consent, semantic recall, guard review, and
agent bindings are configured together:

```sh
git clone https://github.com/veltri-23/vibebloat.git
cd vibebloat
bun install --frozen-lockfile --omit peer
bun link
vibebloat init --pretty
```

Answer each displayed gate explicitly and rerun for the next one:

```sh
vibebloat init --answer "Yes"
vibebloat init --pretty
```

After onboarding reaches its end:

```sh
vibebloat doctor
```

Onboarding preserves existing Claude Code and Codex hook order. It refuses unsafe
configuration shapes instead of overwriting them and installs only selected,
verified bindings.

## Non-interactive lower-level install

`vibebloat install --yes` exists for controlled automation. It installs bindings
without personalized history mining, semantic-recall selection, incident review,
or guard approval. New users should run `vibebloat init --pretty` instead.

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

A source checkout builds the `vibebloat` runtime extension for OpenClaw `>=2026.4.0`
to `dist/openclaw-plugin.js` (run `bun run build:openclaw`); once VibeBloat is
published, the npm package will ship it. Load it through OpenClaw's host-managed
extension flow. Do not treat an `OPENCLAW_SESSION` environment variable as proof
that the plugin is installed.

## Universal fallback

Provide absolute paths to an empty shim directory and the real Git executable:

```sh
vibebloat install --yes --fallback-shim-dir <absolute-shim-dir> --fallback-git <absolute-git-executable>
```

Place the shim directory first on PATH in fresh bash, zsh, fish, and PowerShell
sessions before installation. Missing shells or PATH drift stop fallback install.

## Verify

The `git-stash-u` guard is situational: it only fires in a working tree that has
uncommitted state to lose, so verify from inside a dirty repo. In a scratch directory:

```sh
git init -q -b main
printf 'baseline\n' > tracked.txt && git add tracked.txt
git -c user.email=t@t -c user.name=t commit -q -m init
printf 'edit\n' > tracked.txt   # leave an uncommitted change
printf '%s' '{"tool_input":{"command":"git stash -u"}}' | vibebloat hook
```

Expected result: exit code `2` plus a four-line scrubbed block receipt. Run the same
command from a clean, committed tree and it exits `0` — the guard has nothing to
protect there. Repeat through each installed agent before relying on a guard.
