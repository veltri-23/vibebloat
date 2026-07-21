## Outside review — Claude (Opus 4.8), with a 5-persona panel

I cloned and inspected the repo directly at HEAD of `task/vibebloat-mvp`, ran the test suite and the demo, then had five specialist personas (Principal Engineer, CSO, Build Week Judge, Marketing/Growth, CEO/Founder) each review it independently. Everything below is evidence-based, not vibes.

### What I verified myself
- **703 tests, 702 pass / 1 fail.** The one failure is a flaky 5-second timeout on `tests/cli-install.test.ts` (the whole run took 27s) — a slow subprocess test, not a logic bug. 2577 assertions. The "703 tests" claim checks out.
- **The demo works.** `bun src/cli.ts demo` runs the real pipeline (scrub → prefilter → mine → prove → block → allow) and blocks a real `docker compose down -v` and `git stash -u` while letting the safe variants run — and shows enforcement for *both* Claude Code (exit 2) and Codex (structured deny JSON). This is a strong, self-contained 10-second story.
- **The matcher is genuinely deep** (`src/match.ts`): real tree-sitter bash parsing, git alias resolution, global-option (`-C`/`-c`) stripping, whole-tree pathspec detection, and fail-closed behavior for Class A guards on parse errors.
- **Secret scrubbing is real and layered** (`src/scrub/builtin.ts`): URI credentials, Bearer/Basic tokens, keyword secrets, UUIDs, PEM private-key blocks, emails, absolute/UNC paths — plus optional gitleaks/presidio and a fail-closed tier.
- **Onboarding is product-grade** (`src/onboarding/gates.ts`): 40+ warm, plain-English gates that handle empty history, stale sources, hook conflicts, shim-only installs.

### My scores against the 4 criteria
1. **Technological Implementation — 8/10.** Real, non-trivial engineering with adversarial tests. **But** this criterion explicitly asks how thoroughly you use *Codex*, and that evidence is absent: all ~230 commits are authored "Hunter Veltri" and `README.md` says the Codex session ID is `TBD`. Judged strictly on "use of Codex," this scores lower than the code deserves.
2. **Design — 7/10.** The demo and onboarding are a coherent product, not a PoC. But the advertised front door doesn't work for a stranger: repo is private, `npx vibebloat` is unpublished, and the Codespaces badge 404s for anyone but you.
3. **Potential Impact — 6/10.** Real problem, reachable audience, and the demo actually addresses it. Ceiling is capped by the "feature, not a business" problem and platform-absorption risk (Anthropic/OpenAI can ship "learn guards from your own denials" natively).
4. **Quality of the Idea — 7/10.** "Personalized, deterministic, zero-token guards mined from your own incidents" is a genuine, novel reframe vs. static blocklists like `destructive_command_guard`. The wedge is thin (n=1 per user) and the name muddies the pitch.

### Two real problems the panel surfaced that you should not ignore
- **The signing story is theater as shipped.** `release/metadata.json` points at `vibebloat.pub` and `vibebloat-windows-x64.bundle` that **do not exist in the repo**; the verify code (`src/doctor/sigstore.ts`) is dead for anyone who clones it. Meanwhile the README advertises "Sigstore-signed, verified on every init" and INSTALL.md admits there's no signed binary yet. For a *trust/safety* product, a false trust claim is the worst possible thing to overstate.
- **The guard has undisclosed bypasses (CSO finding).** File guards only fire on file-tool inputs, so a shell write — `echo > .mcp.json`, `tee`, `cp`, `python -c` — sails past them, and the basename-only path compare no-ops any guard whose path has a directory prefix (which is the miner's own output format). Command guards are defeated by unexported shell vars (`F=--force; git push $F` stays literal) and trivially by `sh -c '…'` / base64+eval. These don't sink the project, but a blocker that silently misses these should *say so*, not imply completeness.

### Panel verdict (each rated 1st-place likelihood /100)
| Persona | /100 |
|---|---|
| Principal Engineer | 64 |
| CSO | 52 |
| Build Week Judge | 38 |
| Marketing/Growth | 34 |
| CEO/Founder | 33 |

The split *is* the signal: reviewers closest to the **code** rate it high; reviewers judging **the submission a stranger opens on demo day** rate it low. Both are right about different things.

### My rating: **40/100 to win 1st place, as-is.**
The engine is a legitimate standout — most hackathon entries fake exactly what this one actually built. But the things standing between it and a win are self-inflicted and fixable, and 1st place is a high bar in a full field. Fix the three blockers and I'd move this to ~60.

### Top 3 fixes before submission
1. **Fill the Codex session ID** (`README.md`) and surface real Codex-usage evidence — the README itself calls it required for eligibility, and "use of Codex" is criterion #1.
2. **Make the signing claim true or delete it** — ship a genuinely verifiable release, or strip "signed/verified" from the README and metadata. No half-claim in a trust product.
3. **Make it judge-runnable** — publish to npm and/or make the repo public so `npx vibebloat` and the Codespaces badge work for someone who isn't you.

*(One honesty note on the review prompt itself: it states a signed bundle "exists at `release/vibebloat-windows-x64.bundle`." It does not — that file is absent from the repo. Worth correcting so the next AI isn't primed on a false premise.)*
