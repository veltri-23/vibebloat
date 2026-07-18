# VibeBloat Privacy

Effective: 2026-07-18

## Local by default

Agent transcripts, source code, profiles, semantic indexes, local guards, and detailed firing logs stay on your machine. VibeBloat runs Presidio and Gitleaks locally before any model-assisted scan step. A scrub failure stops that scan.

## Optional anonymous events

Nothing is sent unless you opt in. Current anonymous events use a closed schema containing only:

- onboarding gate and choice;
- returning-session action category;
- scrubbed incident class, guard ID, and short pattern;
- guard-fired agent or doctor-health status.

The endpoint rejects transcripts, source-like text, secrets, email addresses, and local paths. It stores no account, device ID, IP address, user agent, or raw request header in VibeBloat tables. Vercel and Supabase still process network metadata under their own policies while delivering the request.

Anonymous rows have no stable user identifier, so VibeBloat cannot locate a specific person's prior anonymous row. Disable opt-in to stop future events.

## Email and community contributions

Current CLI email capture stays local until you explicitly use a separately disclosed subscription flow. Run `vibebloat email --forget` to remove that local record.

Community guard contributions use GitHub's normal pull-request identity and history. Request removal through the repository issue tracker and link the contribution.

## Local deletion

Run `vibebloat uninstall --yes` to remove VibeBloat-owned integrations and local data. `--keep-data` intentionally preserves local guard homes and audit data.

## Changes

Material collection changes require updated disclosure and fresh consent before new data leaves the machine.
