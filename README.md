# VibeBloat

Local tripwires for mistakes AI coding agents repeat.

## Status

Hackathon build in progress. Do not treat this package as a published release yet.

## What it does

VibeBloat reads explicitly approved local agent history, runs Presidio and Gitleaks
before any model pass, and compiles repeated incidents into declarative guards.
Claude Code, Codex, OpenClaw, Hermes, and fallback chokepoints share one deterministic
matcher and five trusted runtime actions.

Unlike `destructive_command_guard`, VibeBloat learns personalized guards from a user's
own repeated incidents instead of shipping a universal command blocklist.

## Install

Public npm and signed-binary installs are not live yet. Use the source-checkout steps
in [`INSTALL.md`](INSTALL.md) during development.

## Demo

The live-compile-elevation acceptance path is reproducible locally:

```sh
bun test tests/e2e/demo-shot-5.test.ts tests/e2e/demo-shot-6.test.ts
```

## How it works

1. Discover local histories without exposing their paths.
2. Require explicit source confirmation and privacy consent.
3. Scrub locally with both required scrubbers; any failure halts ingest.
4. Mine, review, compile, and prove declarative guards.
5. Install only human-approved guards through native and fallback chokepoints.

## Custom guards

Guards contain data, never executable code. Validate a guard and synthetic event with:

```sh
vibebloat eval < test-case.json
```

Community contribution rules live in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Build Week provenance

Core implementation was built with Codex for OpenAI Build Week. Hackathon-eligible
product work in this repository begins after 2026-07-13.

## Development

```sh
bun test
bun src/cli.ts doctor
```

## Architecture

- Guards are declarative data.
- Trusted runtime actions perform every effect.
- History is scrubbed before any model pass.
- Native agent hooks and fallback chokepoints share one matcher.

## License

Apache-2.0. See `LICENSE`.
