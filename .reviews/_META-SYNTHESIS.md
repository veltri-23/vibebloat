# VibeBloat — External Review Synthesis

*Report written by Claude (Opus 4.8).*

Independent review + 5-persona panel. Repo inspected directly at HEAD of `task/vibebloat-mvp`.

## Ground truth I verified myself (not taken on faith)
- 123 TS source files / ~15k LOC; 141 test files / ~12k test LOC.
- `bun test` → **702 pass / 1 fail** (the 1 = a flaky 5s timeout on `cli-install.test.ts`, run took 27s; not a logic bug), 2577 assertions. The prompt's "703 tests" is accurate.
- `bun src/cli.ts demo` runs the full pipeline (scrub→prefilter→mine→prove→block→allow) end to end and blocks real commands for both Claude Code (exit 2) and Codex (structured deny JSON). It works.
- `src/match.ts`: real tree-sitter bash parse, git alias resolution, git global-option (`-C`/`-c`) stripping, whole-tree pathspec (`.`,`:/`) detection, Class-A fail-closed on parse error. Genuinely deep.
- `src/scrub/builtin.ts`: layered redaction (URI creds, Bearer/Basic, keyword secrets, UUIDs, PEM private-key blocks, emails, abs/UNC paths) + optional gitleaks/presidio + fail-closed tier. Secret-before-model story holds.
- `src/onboarding/gates.ts`: 40+ warm, edge-case-handling conversational gates. Product-grade.
- **RED FLAGS confirmed on disk:** `release/vibebloat-windows-x64.bundle` and `release/vibebloat.pub` do **not exist**; only `release/metadata.json` (pointing at the missing files) is tracked. The `.exe` and the encrypted private key are gitignored. Repo is **PRIVATE**, **0 stars**, default branch is a task branch, `npx vibebloat` unpublished. README claims "Sigstore-signed, verified on every init"; INSTALL.md admits no signed binary yet.

## Panel scores (each rated 1st-place likelihood /100)
| Persona | Win/100 | Core scores |
|---|---|---|
| Principal Engineer | 64 | Tech impl 9/10, quality A− |
| CSO | 52 | Tech (sec lens) 7/10, posture C |
| Build Week Judge | 38 | 8/7/8/8, readiness 6, NO-SHIP as-is |
| Marketing/Growth | 34 | Idea 7, demo 7, memorability 6 |
| CEO/Founder | 33 | Impact 5, idea 6 |

Mean ≈ 44. The split is the story: reviewers closest to the **code** rate high; reviewers judging the **submission as a stranger sees it on demo day** rate low.

## Consensus (all 5 agreed)
1. The core enforcement engine is real, deep, and well-tested — not faked. Standout for a hackathon.
2. The submission is **not ship-ready**: the advertised signed release is missing/theater, `npx` unpublished, repo private (judges can't open it), README↔INSTALL contradiction, Codex session ID `TBD`, all ~230 commits authored by the human → the "use of Codex" criterion has no evidence.
3. (CSO) Real, undisclosed guard bypasses exist — shell redirection defeats the whole file-guard class; unexported `$VAR` and `sh -c` defeat command guards.

## My rating
**40/100 for 1st place as-is.** Ceiling is high (great engine), but the specific failures are exactly the ones judges punish, and 1st is a high bar in a large field. Fix the 3 blockers below → ~60/100.

## Top 3 fixes before submission
1. Fill the Codex session ID and surface real Codex-usage evidence (README says it's required for eligibility; all commits are human-authored).
2. Either ship a genuinely verifiable signed release, or delete the "signed/verified" claim everywhere. A false trust claim in a trust product is the worst possible place to overstate.
3. Make it judge-runnable: publish to npm and/or make the repo public so the advertised `npx vibebloat` / Codespaces path works for a stranger.
