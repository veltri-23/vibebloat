# Contributing

This repository is Apache-2.0. Keep changes focused and add focused `bun:test`
coverage for behavior changes. Never commit secrets, transcripts, runtime state,
or generated release artifacts.

## Community guards

Community guards are submitted to the owner-curated `vibebloat-library`, not
installed from this repository directly. A submission is exactly:

```
library/<class>/<slug>/
  guard.json
  test.json
  meta.json
```

Use the guard shape in `src/types.ts`, validated by `src/schema.ts`. Library
submissions use the library's `schema/guard.schema.json`; the slug must match
`guard.json.id`, `tier` must be `community`, and actions must be trusted runtime
verbs. No scripts, binaries, custom actions, raw incident data, absolute paths,
usernames, or secrets.

`test.json` must contain at least one synthetic event that fires and one
true-negative event that stays silent. Prove both with the same runtime path:

```
vibebloat eval < test-case.json
```

The input is JSON with `guard` and `event`; a fired case returns `fired: true`.
Submit the events and expected results in `test.json`.

## Review and DCO

Guard-library commits require a Developer Certificate of Origin trailer:

```
Signed-off-by: Your Name <you@example.com>
```

Use `git commit -s`. Open a pull request after local proof; maintainers run the
curation checks and explicitly approve publication. Passing validation never
auto-publishes a guard.
