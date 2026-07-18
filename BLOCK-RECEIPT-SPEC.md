# Block Receipt Contract

## Scope

Terminal receipt for a fired VibeBloat rule. This contract defines presentation
only; it does not change matching, action routing, override lifetime, or agent
transport payloads.

Use literal status text. Do not use emoji, pictographs, or decorative icons.
The receipt is four content lines maximum. Borders, if a host renders them, do
not add content lines.

## Four-Line Layout

```
BLOCKED  guard: git-stash-u  class: A
incident: untracked-file loss  date: 2026-07-15
why: prevented a repeated destructive action
fix: vibebloat allow git-stash-u --once
```

1. **Status:** `BLOCKED` for a blocking action or `WARNING` for a warning;
   include guard ID and class.
2. **Provenance:** include the safe incident summary and `provenance.date` in
   ISO `YYYY-MM-DD` form.
3. **Reason:** concise, scrubbed explanation of what VibeBloat did.
4. **Fix:** safe remediation. A one-time override appears only as the generated
   `vibebloat allow <guard-id> --once` command.

No blank lines, dividers, progress text, transcript excerpts, or extra context
may displace these four lines. Trim content rather than wrapping it; a narrow
terminal may horizontally scroll or use an accessible wrapped view that retains
the same four fields.

## Meaning

`BLOCKED` means the rule action is `block` and the attempted action is denied.
Direct hook transports return their blocking result; structured agent transports
return their native deny decision. `WARNING` means the rule action is `warn`:
the action continues, with `blocked: false` and a warning attached. Guard class
does not override action semantics.

The receipt only describes a verdict that has already fired. It must never
imply a block for an allow, a false match, or a parser fallback.

## Safe Fields

Receipt rendering is a local disclosure boundary. It may use only:

- literal status derived from the action type;
- guard ID and class;
- a scrubbed incident summary plus incident date;
- a scrubbed reason; and
- a generated one-time override or a fixed safe remediation.

Never render raw `Event.command`, command arguments, tool payloads, transcript
text, evidence references, environment values, absolute paths, usernames,
authorization headers, bearer tokens, API keys, or any secret. Do not trust an
incident summary or action message as display-safe by default; redact it before
rendering. If redaction leaves no useful text, use `incident: redacted` or
`why: sensitive detail withheld` while retaining the date and verdict.

## Typography And Tokens

Use `JetBrains Mono`, then `Menlo`, then a monospace fallback for every receipt
line. Use IBM Plex Sans for surrounding CLI help/captions and IBM Plex Serif
only for non-terminal headings. Receipt body size is at least 16px wherever a
host controls typography.

Light is the product default. Dark is a terminal-host compatibility variant,
not a site-mode change.

| Token | Light receipt | Dark terminal receipt |
|---|---|---|
| Surface | `#fafaf7` paper, with status tint | `#1a1a1a` ink surface, with status tint |
| Primary text | `#1a1a1a` | `#fafaf7` |
| Secondary text | `#404040` | `#a8a8a8` |
| Hairline | `#e6e4dc` | `#404040` |
| Block accent | `#d63841`; 3px top rule; 4% tint | `#d63841`; 3px top rule; 8% tint |
| Warn accent | `#f59e0b`; 3px top rule; 4% tint | `#f59e0b`; 3px top rule; 8% tint |

Accent colors are status markers, not body-text colors. Keep body text on the
primary/secondary token so it maintains readable contrast. Plain-text terminal
output keeps the literal `BLOCKED` or `WARNING` label; color may reinforce, but
never carry, meaning.

## Acceptance Checklist

- [ ] Renderer produces no more than four content lines and uses literal status
      text with no emoji or pictographs.
- [ ] First two lines contain action-derived status, guard ID, class, incident
      summary, and ISO incident date.
- [ ] `block` denies matching work and `warn` permits matching work while
      attaching its warning. Existing runtime proof: `tests/actions.test.ts`.
- [ ] Direct hook blocking and one-time override behavior remain intact.
      Existing CLI proof: `tests/cli-allow.test.ts`.
- [ ] Claude/Codex blocking transports preserve their native deny behavior.
      Existing hook proof: `tests/hooks.test.ts`.
- [ ] A compiled learned rule continues to deny across Claude Code, Codex,
      OpenClaw, and Hermes. Existing E2E proof: `tests/e2e/cross-agent.test.ts`.
- [ ] Live compile installs a rule that blocks its retry. Existing E2E proof:
      `tests/e2e/demo-shot-5.test.ts`.
- [ ] New receipt rendering tests inject secrets into command, payload, and
      incident fields, then prove none reach receipt output.
- [ ] Light and dark render checks verify token use, 3px status rule, and
      16px minimum controlled-host type size.
