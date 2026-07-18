# Site Contract

Baseline Vercel surface only. Hunter and Claude own final visual design and final
hero wording. Implementation must preserve these locked product and accessibility
constraints.

## Information architecture

```text
header: wordmark | library link
main
  hero: wordmark -> token-tax headline -> support -> install CTA -> real terminal receipt
  library: search -> class/confidence/agent filters -> guard table
  install: one command -> per-OS details
footer: GitHub | npm | install
```

No feature-card grid. Sections follow content shape and stay left-aligned.

## Hero

- Headline communicates memory/token tax, not generic agent productivity.
- Supporting sentence states outcome: repeat mistakes become local deterministic guards.
- One primary install CTA. No competing button row.
- Block proof uses a real captured terminal state before launch, never a decorative mock.
- Final copy remains Hunter-owned; baseline copy may change without altering IA.

## Curated library

Library is a table, not cards. Each row exposes ID, class, confidence, bound agents,
description, and command pattern when safe to publish.

Search is case-insensitive full text across:

- guard ID and description;
- safe command patterns;
- class A/B/C/D;
- confidence high/medium/low;
- bound agent: Claude Code, Codex, Hermes, OpenClaw, or all.

Class, confidence, and agent filters combine with search using AND semantics. Multiple
values inside one filter use OR semantics. Empty controls show all curated guards. A
no-results state says which search and filters produced zero matches and offers one
clear-control action. Search and filtering stay client-side for the baseline; no query
or guard content leaves the page.

## Install

Primary install command links to the per-OS contract in `INSTALL-MATRIX-SPEC.md`.
Until npm and signed release assets exist, the site labels source-checkout commands as
development instructions and must not claim a public install succeeded.

## Visual rules

- Light warm paper background (`#fafaf7`), ink text, one burnt-orange accent.
- IBM Plex Serif display, IBM Plex Sans body, JetBrains Mono terminal surfaces.
- 16px minimum body copy; 4px maximum control radius.
- No emoji, purple gradients, colored-circle icons, decorative blobs, or centered-everything layout.
- Library stays horizontally scrollable on narrow screens; it never collapses into a card grid.

## Accessibility gate

- Body text and interactive labels meet WCAG AA 4.5:1 contrast.
- Header, main, sections, and footer use semantic landmarks and named headings.
- First focusable item is a visible-on-focus skip link to `main`.
- Every control is keyboard reachable, has a persistent label, and has a 44px minimum target.
- Focus uses a visible 2px accent outline with 2px offset.
- Library status changes announce through `aria-live="polite"`; table keeps accessible headers.
- Images require useful alt text; decorative images use empty alt text.
- Automated accessibility checks supplement keyboard and screen-reader smoke tests.

## Acceptance

- IA order matches this contract at desktop and mobile widths.
- Search covers descriptions and safe command patterns; all three filter groups compose.
- Anti-slop checklist has no violations.
- Contrast, keyboard path, landmarks, labels, focus, and no-results announcement pass.
- Footer exposes GitHub, npm, and install destinations only when those destinations exist.
