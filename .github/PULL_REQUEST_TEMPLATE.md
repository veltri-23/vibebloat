## Change

Describe behavior changed and user impact.

## Verification

- [ ] Focused `bun:test` coverage passes.
- [ ] No secrets, transcripts, runtime state, or generated release artifacts are included.

## Community Guard Submission

- [ ] Not a community guard submission.
- [ ] Or: bundle contains only `guard.json`, `test.json`, and `meta.json` under `library/<class>/<slug>/`.
- [ ] Guard uses `tier: "community"` and only trusted runtime actions; no code, scripts, or binaries.
- [ ] `vibebloat eval` proves one firing synthetic event and one true-negative event.
- [ ] Provenance is scrubbed of secrets, paths, usernames, and raw transcripts.
- [ ] Commit includes a DCO `Signed-off-by:` trailer.

## Review

- [ ] I understand community guards are curated and require maintainer approval before publication.
