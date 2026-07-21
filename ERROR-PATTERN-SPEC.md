# CLI Error Pattern

Recoverable CLI failures write three newline-terminated lines to stderr:

```text
WHAT failed: <operation that stopped>
WHY: <root cause>
FIX: <one actionable repair>
```

`WHAT failed` names the user operation, not an internal function. `WHY` gives one direct
cause. `FIX` gives one repair path, usually a copy-pasteable command with placeholders
for unavailable values.

Failure formatters do not add headings, bullets, emoji, ANSI styling, or stack traces.
Interpolated `WHY` values are not scrubbed by a shared formatter, so callers must not
pass raw history, commands, tokens, secrets, or other sensitive input.

Success output stays on stdout. Two non-failure forms are outside this contract:

- fired guard actions use the four-line receipt in `BLOCK-RECEIPT-SPEC.md`;
- post-write watch observations begin `WHAT detected`.

Exact-output tests should change with any user-visible failure text.
