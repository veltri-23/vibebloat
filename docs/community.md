# Community Guard Contributions

VibeBloat community guards are declarative data. Contributions go to the
owner-curated `veltri-23/vibebloat-library` repository when public submissions
open. This repository contains the runtime and contributor contract; it does
not claim that the library intake or its automation is live.

## Bundle Layout

Submit one guard, or one coherent guard pack, per pull request. Each guard is
exactly one three-file directory:

```text
library/<class>/<slug>/
  guard.json
  test.json
  meta.json
```

- `<class>` is `A`, `B`, `C`, or `D`.
- `<slug>` is kebab-case and equals `guard.json.id`.
- Do not add scripts, binaries, logs, transcripts, generated registry data, or a
  fourth file to the directory.
- Never include secrets, usernames, account identifiers, or absolute paths.

## Schema Sources

Current executable schema lives in:

- `src/types.ts` for `Guard`, `Event`, and trusted action types.
- `src/schema.ts` for runtime guard validation.
- `src/library/validate.ts` for community-only policy and positive/negative proof.

The library repository layout reserves `schema/guard.schema.json` and
`schema/test.schema.json` as machine-readable mirrors. Until those generated
schemas exist in the library repository, current TypeScript source is behavior
truth. Do not copy the older snake-case draft fields from planning documents;
the shipped runtime uses names such as `argsContains` and requires `provenance`
and `enabled`.

A current community shell guard looks like:

```json
{
  "id": "git-stash-u",
  "class": "A",
  "provenance": {
    "incident": "lost untracked files during a stash",
    "date": "2026-07-17",
    "source": "community"
  },
  "match": {
    "chokepoint": "shell",
    "command": "git stash",
    "argsContains": ["-u"]
  },
  "action": {
    "type": "block",
    "message": "Scope the stash before including untracked files.",
    "override": "vibebloat allow git-stash-u --once"
  },
  "confidence": "high",
  "tier": "community",
  "binds": ["claude-code", "codex", "hermes", "openclaw"],
  "enabled": true
}
```

Community validation additionally requires:

- `tier` is `community`.
- `confidence` is explicit; low-confidence guards use `warn`, never `block`.
- `binds` is non-empty and contains only supported agent IDs.
- Shell guards have `match.command`; file guards have `match.path`.
- Actions use only trusted runtime verbs. No script or custom-action field.
- Public provenance is scrubbed and generalized.

## Test Vector

`test.json` contains named synthetic events. At least one case must fire and one
must stay silent:

```json
{
  "guard_id": "git-stash-u",
  "cases": [
    {
      "name": "tp-untracked-stash",
      "expect": "fire",
      "event": { "chokepoint": "shell", "command": "git stash -u" }
    },
    {
      "name": "tn-status",
      "expect": "silent",
      "event": { "chokepoint": "shell", "command": "git status" }
    }
  ]
}
```

`meta.json` carries public attribution and scrubbed provenance:

```json
{
  "contributor": "gh-handle",
  "provenance": {
    "summary": "A broad stash removed work that had not been committed.",
    "date": "2026-07-17",
    "source": "claude-code"
  },
  "submitted_at": "2026-07-18T00:00:00Z",
  "dco": true
}
```

Only the public GitHub handle belongs in attribution. Do not place contributor
PII or raw incident evidence in `meta.json`.

## Eval Proof

`vibebloat eval` reads one JSON object from stdin with `guard` and `event` keys.
It calls the same pure matcher used by live hooks and does not need a live
repository. Eval returns the match verdict without dispatching any action:
`quarantine-file` never moves a file, `run-check` never invokes a check, and no
confirmation callback runs.

For repository development, use `bun run eval`. For an installed CLI, use
`vibebloat eval`. Build a temporary eval envelope outside the three-file bundle:

```json
{
  "guard": {
    "id": "git-stash-u",
    "class": "A",
    "provenance": { "incident": "lost untracked files", "date": "2026-07-17", "source": "community" },
    "match": { "chokepoint": "shell", "command": "git stash", "argsContains": ["-u"] },
    "action": { "type": "block", "message": "Scope the stash.", "override": "vibebloat allow git-stash-u --once" },
    "confidence": "high",
    "tier": "community",
    "binds": ["claude-code", "codex", "hermes", "openclaw"],
    "enabled": true
  },
  "event": { "chokepoint": "shell", "command": "git stash -u" }
}
```

PowerShell:

```powershell
Get-Content -Raw .\fire.eval.json | bun run eval
```

POSIX shell:

```sh
bun run eval < fire.eval.json
```

Expected true-positive result:

```json
{"fired":true,"guardId":"git-stash-u","reason":"Scope the stash."}
```

Change only the event command to `git status` and run again. Expected
true-negative result:

```json
{"fired":false}
```

Eval proves matcher behavior only. Community policy, schema, secret/PII,
collision, and DCO checks remain separate required curation gates.

## DCO

Every guard-library commit requires a Developer Certificate of Origin trailer:

```text
Signed-off-by: Your Name <you@example.com>
```

Create it with `git commit -s`. Missing or mismatched sign-off fails the library
gate. The library is Apache-2.0 and uses DCO instead of a separate CLA.

## Curator Workflow

1. Contributor opens an atomic pull request using the repository template.
2. CI checks bundle scope, schema, trusted actions, fire/silent proof, scrub,
   collision fingerprint, and DCO.
3. Contributor resolves both summary and inline findings until checks are stable
   green.
4. Automation labels the pull request `awaiting-owner-review` and stops.
5. Owner reviews the rendered guard, proof, provenance, warnings, and attribution.
6. Owner approves, requests changes, or holds the submission with a reason.
7. Only owner merges. Passing automation never publishes by itself.
8. Registry and site artifacts regenerate after merge; contributors never edit
   them in the pull request.

The locked review requires a maintainer review SLA, but no numeric response time
is locked in the project record. Current honest service boundary starts only
after stable-green CI and `awaiting-owner-review`; maintainer must return an
explicit approve, changes-requested, or held state. Do not promise hours or days
until the library repository publishes a signed-off duration.

See `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` for repository-level
submission checks.
