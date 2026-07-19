# VibeBloat

**Your agent's memory taxes every prompt. Ours costs nothing and can't be ignored.**

VibeBloat reads your AI agent history, finds every time an agent (or you) broke
something, and compiles each incident into a deterministic guard that blocks
the mistake before it repeats. One heavy scan up front; zero-token enforcement
forever.

Unlike `destructive_command_guard` (5k-star static blocker), VibeBloat learns
*personalized* guards from your own repeated incidents — not a universal
command blocklist.

## See it work in 10 seconds

No history, no API key, no install beyond the repo:

```sh
bun src/cli.ts demo
```

It runs the real pipeline — scrub, prefilter, mine, compile, block — over a
labelled sample history and prints the guards it produced. With a model
configured it mines those findings live; without one it uses the sample's
precomputed findings and says so.

## Try it

The fastest way: open Vibebloat in a pre-configured GitHub Codespace and run
init in the browser. No local install required.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://github.com/codespaces/new?hide_repo_select=true&ref=task%2Fvibebloat-mvp&repo=veltri-23%2Fvibebloat)

Once the Codespace boots, run in its terminal:

```sh
bun src/cli.ts init --pretty
```

Or install locally (after `npm publish` lands):

```sh
npx vibebloat
```

## What a block looks like

```
BLOCKED  guard: git-stash-u  class: A
incident: git stash -u deleted operational untracked files  date: 2026-07-15
why: 07-15 this deleted untracked files. Use git stash -u -- <path> or commit first.
fix: vibebloat allow git-stash-u --once
```

## Install

`npx vibebloat` works once published. Until then, source-checkout steps live in
[`INSTALL.md`](INSTALL.md).

The shipped `vibebloat` standalone binary is Sigstore-signed against the
public key pinned in `src/scrub/controlled-release.ts`. Verified on every
`vibebloat init` before any model pass runs.

## Demo

The cross-agent block acceptance path is reproducible locally:

```sh
bun test tests/e2e/demo-shot-5.test.ts tests/e2e/demo-shot-6.test.ts
```

Shot 5 — the kill shot — shows a fresh Claude Code session hitting the
`git stash -u` block in a live tree. Shot 6 — a different agent (Codex,
fresh session, never saw the incident) — hitting the same block at a
different chokepoint.

## How it works

1. Discover local histories without exposing their paths.
2. Require explicit source confirmation and privacy consent.
3. Scrub locally with Presidio and Gitleaks; any failure halts ingest.
4. Mine, review, compile, and prove declarative guards.
5. Install only human-approved guards through native and fallback chokepoints.

Guards are declarative data. Trusted runtime actions (`block`, `warn`,
`require-confirm`, `quarantine-file`, `run-check`) perform every effect.

## Custom guards

Guards contain data, never executable code. Validate a guard and synthetic
event with:

```sh
vibebloat eval < test-case.json
```

Community contribution rules live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Build Week provenance

Core implementation was built with Codex for OpenAI Build Week. The Codex
session that produced the core build thread:

- **Codex session ID:** `TBD` (fill in from the core-build Codex session before
  submission; required for eligibility per hackathon rules)

Hackathon-eligible product work in this repository begins after 2026-07-13.

## Development

```sh
bun test
bun src/cli.ts doctor
```

Build host standalone binary with `bun run build`. Build supported Windows
x64, macOS x64/arm64, and Linux x64 artifacts with `bun run build:release`.
Sign a release with:

```sh
COSIGN_PASSWORD=... cosign sign-blob --key release/vibebloat.key \
  --bundle release/vibebloat-windows-x64.bundle dist/vibebloat-windows-x64.exe
```

## Architecture

- Guards are declarative data.
- Trusted runtime actions perform every effect.
- History is scrubbed before any model pass.
- Native agent hooks and fallback chokepoints share one matcher.

## License

Apache-2.0. See `LICENSE`.
