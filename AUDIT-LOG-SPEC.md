# Guard Firing Audit Log

Status: T31 contract. Runtime implementation remains separate.

## Purpose

Keep 30 days of local evidence showing which guards fired. Log supports
`vibebloat stats`, returning-user review, and staleness checks without retaining
the command, file path, incident text, or secrets that caused the match.

## Storage

- Machine-local path: `<global VibeBloat home>/audit/firings/`.
- Never write audit data under a repository `.vibebloat/` directory. This keeps
  firing history out of git-backed guard sync.
- One event per JSON file. Write to a sibling temporary file, then atomically
  rename into place. Readers ignore temporary files.
- Files are user-readable only where the platform supports file permissions.
- No network, model, telemetry, publish, or community-library path may read this
  directory unless the user starts a separate explicit export flow.

## Event schema

```json
{
  "schemaVersion": 1,
  "eventId": "random UUID",
  "firedAt": "2026-07-18T12:34:56.789Z",
  "guardId": "git-stash-u",
  "class": "A",
  "chokepoint": "shell",
  "actionType": "block",
  "blocked": true,
  "agent": "codex"
}
```

Required fields: `schemaVersion`, `eventId`, `firedAt`, `guardId`, `class`,
`chokepoint`, `actionType`, and `blocked`. `agent` is optional and may contain
only a supported agent identifier, never a process command line.

## Forbidden data

Audit events must not contain:

- raw or normalized commands, arguments, environment variables, aliases, input
  payloads, file paths, file contents, or working directories;
- guard messages, override commands, provenance incidents, evidence references,
  session IDs, usernames, email addresses, tokens, credentials, or secret values;
- hashes, excerpts, encodings, or other reversible or correlatable derivatives of
  forbidden input.

Only fields in the event schema are allowed. Unknown fields fail validation and
the event is not written.

## Retention

- On startup and after each successful append, delete completed event files with
  `firedAt` older than 30 calendar days relative to UTC now.
- A malformed, future-dated, or unreadable event is quarantined locally and
  excluded from stats. It is never uploaded.
- Pruning failure does not weaken guard enforcement. Emit the standard three-line
  local error and continue the original block/warn decision.
- Uninstall removes this log unless `--keep-data` is supplied.

## Acceptance checks

- A fired verdict creates one valid event after atomic rename.
- A non-fired verdict creates no event.
- Secret-bearing command, path, payload, message, and incident fixtures never
  appear in audit files.
- An event exactly 30 days old is pruned; a newer event remains.
- Network calls and model calls remain zero during append, read, and prune.
