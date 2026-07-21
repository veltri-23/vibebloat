# Block Receipt Contract

`src/block-receipt.ts` renders receipts only for fired `block` and `warn` actions.
Other action types have no block receipt.

## Layout

Receipts contain exactly four lines and no blank lines:

```text
BLOCKED  guard: git-stash-u  class: A
incident: untracked-file loss  date: 2026-07-15
why: prevented a repeated destructive action
fix: vibebloat allow git-stash-u --once
```

- Line 1 uses `BLOCKED` for `block` and `WARNING` for `warn`, followed by guard ID
  and class.
- Line 2 contains scrubbed incident text and an ISO `YYYY-MM-DD` date.
- Line 3 contains the scrubbed runtime reason.
- Line 4 uses `vibebloat allow <guard-id> --once` for a block and
  `vibebloat disable <guard-id>` for a warning.

`block` returns a deny result. `warn` leaves the action allowed with `blocked: false`.
Guard class does not override action semantics.

## Disclosure boundary

The renderer validates guard ID, class, and date, removes line breaks and non-ASCII
characters, caps field lengths, and redacts credentials, tokens, usernames, email
addresses, and absolute paths. Empty scrubbed incident or reason fields become
`redacted` or `sensitive detail withheld`.

Raw commands, arguments, tool payloads, transcript text, evidence references,
environment values, and secrets must never reach output. ANSI red or yellow may color
the literal status on a TTY; color never carries meaning and is absent off-TTY.
