# OpenAI Build Week Judge Guide

**Track:** Developer Tools  
**Repository:** <https://github.com/veltri-23/vibebloat>  
**License:** Apache-2.0  
**Codex session ID:** `019f7184-325b-7ec0-879a-856b59de5e17`

VibeBloat is a private, personalized learning loop for coding agents. It onboards
to each developer's tools and history, retrieves old incidents semantically even
when the next mistake is reworded, and keeps proposing stronger protections as
new history arrives. Human-approved lessons compile into deterministic,
cross-agent guards that run before dangerous commands execute.

## What makes it different

1. **Onboarding is custom to you.** VibeBloat detects agent runners and history
   sources, asks explicit privacy and recall questions, measures the available
   evidence, and installs only approved integrations and guards.
2. **Recall is semantic.** Optional local MiniLM embeddings retrieve incidents by
   meaning rather than exact tokens. A destructive-shape prefilter keeps benign
   same-tool commands quiet and avoids unnecessary model startup.
3. **It learns over time.** Returning-user incremental scans and an optional
   native daily scheduler propose new or strengthened guards as history grows.
4. **Learning cannot silently become enforcement.** Semantic hits remain
   advisory. Every promotion to a hard block requires human approval, and the
   runtime hot path remains deterministic.

## Two-minute evaluation

Prerequisites: Git and [Bun](https://bun.sh) `>=1.3.0`.

```sh
git clone https://github.com/veltri-23/vibebloat.git
cd vibebloat
bun install --frozen-lockfile --omit peer
bun link
vibebloat demo --no-model
```

This demonstration uses labelled, invented sample history. It does not read your
agent history, needs no API key, and makes no model call.

Expected proof:

```text
SAMPLE DATA — invented history, not yours
prove      3 guards block the exact command that caused the incident, with exit code 2
allow      2 safe variants of the same commands run untouched
```

The output then shows:

- `docker compose down -v` blocked with exit code `2`.
- `git stash -u` blocked with exit code `2`.
- `write .mcp.json` blocked with exit code `2`.
- Safe variants `docker compose down` and `git stash` allowed with exit code `0`.
- Same guard returned as a structured Codex `PreToolUse` denial.

This proves the final enforcement result. The personalized learning system that
produces those guards can be evaluated below.

## Evaluate personalized onboarding

This is the recommended real installation path, also shown near the top of the
[README](README.md#install-and-onboard-recommended). Do not run the low-level
`install --yes` command first; it bypasses the personalized mining and approval
flow that makes VibeBloat useful.

```sh
vibebloat init --pretty
```

The flow is deliberately explicit and resumable. Submit an option exactly as
shown, then rerun for the next gate:

```sh
vibebloat init --answer "Yes"
vibebloat init --pretty
```

The onboarding detects supported agents and history sources, explains what it
would read, asks for consent, lets the user choose lexical or local semantic
recall, reviews mined incidents, and installs only explicitly approved guards.
The user can decline before any personal history is ingested.

Automated onboarding proof:

```sh
bun test tests/e2e/onboarding-12min.test.ts tests/install-onboarding-bindings.test.ts tests/onboarding-returning.test.ts
```

## Evaluate semantic and ongoing learning

Fast deterministic coverage:

```sh
bun test tests/recall-local.test.ts tests/onboarding/returning-service.test.ts tests/onboarding-daily-scheduler.test.ts
```

Optional live MiniLM coverage requires Node.js `>=20` and downloads the model on
first run:

macOS or Linux:

```sh
VIBEBLOAT_REQUIRE_REALMODEL=1 bun test tests/recall-local-realmodel.test.ts
```

Windows PowerShell:

```powershell
$env:VIBEBLOAT_REQUIRE_REALMODEL = '1'
bun test tests/recall-local-realmodel.test.ts
```

The real-model test requires benign same-family Git commands to remain below the
warning threshold while a genuine reworded destructive incident remains above
it. If the model cannot load, the required gate fails instead of reporting a
false green result.

## Reproduce the submitted proof

```sh
bun test tests/e2e/demo-shot-5.test.ts tests/e2e/demo-shot-6.test.ts
```

Expected result:

```text
2 pass
0 fail
```

- **Shot 5:** burn a real disposable file, detect the incident, compile a guard
  off the enforcement path, require approval, then block the retry.
- **Shot 6:** prove one guard blocks through independent agent transports.

Verify the distributable entry point:

```sh
bun src/cli.ts __distribution_probe__
```

Expected result: `vibebloat:dist:ok`

## Full verification

```sh
bun test
python -m pytest -q hermes/tests
bun run build:release
npm pack --dry-run
```

Public default-branch CI is green for validation plus standalone builds on:

- Windows x64
- Linux x64
- macOS x64
- macOS arm64

[Open the green CI run](https://github.com/veltri-23/vibebloat/actions/runs/29882290235).

## What to inspect

| Concern | Source |
| --- | --- |
| Deterministic command parsing and matching | [`src/match.ts`](src/match.ts) |
| Five fixed enforcement actions | [`src/runtime/actions/`](src/runtime/actions/) |
| Scrub-before-model fail-closed gate | [`src/scrub/fail-closed.ts`](src/scrub/fail-closed.ts) |
| History scan pipeline | [`src/ingest/scan.ts`](src/ingest/scan.ts) |
| Incident-to-guard live compile | [`src/compiler/live-compile.ts`](src/compiler/live-compile.ts) |
| Cross-agent hook bindings | [`src/hooks.ts`](src/hooks.ts) |
| End-to-end submitted proof | [`tests/e2e/`](tests/e2e/) |

Core flow:

```text
Incident -> Guard -> Action -> Chokepoint
```

The model may discover a candidate guard during a scan. Enforcement uses inert
guard data and deterministic code; no model participates in the command hot path.

## Supported environments

- Core CLI: Bun `>=1.3.0` on Windows, Linux, and macOS.
- Local neural recall: optional Node.js `>=20`; failure degrades to no neural
  recall and never blocks or crashes command enforcement.
- Hermes adapter and tests: Python.
- Agent surfaces: Claude Code, Codex, Hermes, OpenClaw, Git hooks, and shell shim.

## Privacy and security properties

- History discovery requires explicit consent before ingest.
- Presidio-style and Gitleaks-compatible scrubbers run before any model pass.
- Scrub failure halts ingest; no unsanitized payload leaves the machine.
- Class A parse errors fail closed. Lower-risk advisory classes fail open.
- Guard files use atomic replacement so hooks never read partial writes.
- Repository history received a full secret scan before publication. Findings
  were limited to synthetic secret-scrubber test fixtures.

## Honest release status

VibeBloat is judge-ready from source. It is not yet published to npm and no
Sigstore-signed GitHub Release has been published. Do not use `npx vibebloat`
for this evaluation; use the source commands above.

Real-history onboarding is available with:

```sh
bun src/cli.ts init --pretty
```

That path reads local agent history only after its consent gates. The deterministic
sample demonstration remains the fastest and safest judging path.
