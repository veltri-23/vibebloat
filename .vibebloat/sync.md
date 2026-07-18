# Repository Guard Sync

Tracked guard directory: `.vibebloat/guards/`

This repository opts into Git-backed guard sharing only when a human runs
`vibebloat sync --pull` or explicitly enables its background equivalent. The command
uses this repository's configured upstream, validates candidate guards before they
become active, requires fast-forward history, and runs doctor afterward.

Do not place transcripts, incident quotes, raw commands, secrets, paths, overrides,
logs, checkpoints, receipts, hooks, binaries, or machine-only guards in this folder.
See `vibebloat-sync.md` for full behavior and recovery rules.
