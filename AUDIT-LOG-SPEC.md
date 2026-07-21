# Guard Firing Audit Log

## Storage and schema

Fired guards append one JSON file under `<global VibeBloat home>/audit/firings/`.
Non-fired verdicts write nothing. Event files are written through a sibling temporary
file and atomic rename; audit data never belongs in a repository `.vibebloat/`
directory.

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

The schema is closed. `agent` is optional; every other field is required. A successful
append also updates `<global VibeBloat home>/audit/last-fired/` with the latest timestamp
for that guard. On non-Windows systems audit directories use mode `0700` and files use
`0600`.

## Privacy boundary

Events contain verdict metadata only. They must not contain commands, arguments,
payloads, paths, working directories, file contents, guard messages, incident text,
evidence references, environment values, user identifiers, credentials, secrets, or
derivatives of those values. Invalid or unknown fields reject the event before write.

Audit readers are local runtime paths used by `stats`, returning-user review, and doctor
staleness checks. They do not publish audit contents.

## Retention and failure

Reads and successful appends prune events at least 30 days old, measured as 30 × 24
hours. Malformed, unreadable, future-dated, or incorrectly named event files move to the
local audit quarantine and do not contribute to stats.

Audit cleanup, permission hardening, or summary failures return a local three-line
warning with `FIX: vibebloat doctor`; they do not change the original guard verdict.
`vibebloat uninstall --yes` removes audit data. `--keep-data` preserves it.
