# Static Site Contract

Shipped files live in `site/`. `src/distribution/site.ts` verifies that Vercel points to
that static output, referenced assets stay inside it, and required sections appear in
order.

## Page structure

```text
header: wordmark | guard-library link
main
  hero: token-tax headline | support | install CTA
  four-line block receipt
  library: search | filters | guard table
  install: development source-checkout command
footer | privacy link
```

Sections stay left-aligned. There is no feature-card grid.

## Guard library

The library is a table exposing guard ID, description, safe pattern, class, confidence,
and bound agents. Client-side search covers all six fields. Class A-D, confidence
high/low, and Claude Code/Codex/Hermes/OpenClaw filters combine with search using AND
semantics; multiple checked values within one filter use OR semantics.

Empty controls show all rows. A no-results state names active criteria and points to the
single Clear filters action. Search and filtering do not send guard data off-page.

## Install and release claims

The current page labels its command `Development source checkout:`. It must not claim a
public npm install or signed release while those artifacts are unavailable.

## Visual and accessibility rules

- Warm paper background (`#fafaf7`), ink text, and one burnt-orange accent.
- IBM Plex Serif display, IBM Plex Sans body, and JetBrains Mono terminal surfaces,
  each with local fallbacks.
- 16px body text, 4px maximum control radius, and horizontally scrollable tables on
  narrow screens.
- Visible skip link, semantic header/main/sections/footer, persistent control labels,
  44px search/filter targets, visible 2px focus outline, `aria-live="polite"` result status,
  and accessible table headers.
- No emoji, gradients, decorative icon fields, or card conversion on mobile.
