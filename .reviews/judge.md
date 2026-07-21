# VibeBloat — Build Week Judge Scorecard

**Judge persona:** Cold hackathon judge, submission #41 of the day. I reward a working, novel, well-presented thing and punish vaporware. I ran the demo. I read the code. I checked the release contract against disk.

**Ground truth I verified:** 123 TS files / 141 test files; `bun test` ≈ 702 pass / 1 flaky-timeout fail; tree-sitter bash matcher in `src/match.ts`; 40-gate onboarding in `src/onboarding/gates.ts`; `bun src/cli.ts demo` runs the full scrub→mine→prove→block→allow pipeline and produces real blocks for Claude Code (exit 2) *and* Codex (structured deny JSON). All confirmed live.

---

## 1. Technological Implementation — 8/10

This is genuine, non-trivial, working engineering, not a wrapper.

- `src/match.ts` (208 LOC) parses bash with tree-sitter and defends real bypasses: strips git global options (`-C`, `-c`, `--git-dir`), normalizes binaries (`git.exe`/`.cmd`), and does per-letter bundled-flag matching (`argMatches`, lines 25–30). That is the hard, correct way to do this — regex blockers get trivially bypassed; this one resists it.
- Cross-agent enforcement is real and demonstrated: Claude Code gets `exit 2`, Codex gets `{"hookSpecificOutput":{"permissionDecision":"deny",...}}`. One matcher, two chokepoints (README "How it works" #5, confirmed in demo output).
- 702 passing tests / 2577 assertions is serious coverage for a hackathon. The one failure is a 5s install-timeout flake, not a logic defect.

**The Codex-usage deduction.** The named criterion is *skillful use of Codex*, and the evidence for that specific claim is thin. All 230 commits are authored "Hunter Veltri" (`git log --format=%an`), and the README's provenance block (line 127) reads **`Codex session ID: TBD`** — the field the README itself calls "required for eligibility per hackathon rules" is blank. The code is excellent; the proof it was built *with Codex* is absent. A judge can't score what isn't shown. Strong artifact, unverifiable Codex story → 8, not 9–10.

## 2. Design — 7/10

A coherent product, not a PoC — but the front door is broken.

- `bun src/cli.ts demo` is an excellent 10-second product experience: labelled sample data, honest "SAMPLE DATA — invented history" banner, a legible narrated pipeline, and a real block receipt. This is the best thing in the submission.
- Real supporting surface: accessible landing page (`site/index.html` — skip-link, aria-labelled sections, a searchable/filterable guard library), `doctor`/`eval`/`allow` subcommands, uninstall + upgrade specs, a 40-gate onboarding flow written in plain human language (`gates.ts` F0/F2/J1).
- **But** the advertised install path does not run: `npx vibebloat` is unpublished, and the repo is **private** — a judge normally cannot browse or install it. The only paths that actually work are a source checkout or the Codespace button. A product whose primary install is vapor loses design points even when the core is polished.

## 3. Potential Impact — 8/10

Credible, specific, and *demonstrated*.

- The problem is real and concrete: agents repeating destructive commands (`git stash -u`, `git reset --hard`, `docker compose down -v`, `.mcp.json` written to the wrong file). These aren't hypotheticals — they mirror actual incident history, and the shipped guard library encodes them.
- The framing is sharp and differentiated: "your agent's memory taxes every prompt; ours costs nothing and can't be ignored." Zero-token deterministic enforcement vs. RAG-memory is a genuine, defensible insight.
- Crucially, the demonstrated code *addresses* the stated problem: it blocks the exact incident command with `exit 2`/deny while letting the safe variant (`git stash`, `docker compose down`) run untouched. Precise, not blanket. That closes the loop from claim to behavior.

## 4. Quality of the Idea — 8/10

"Compile an agent's own repeated mistakes into personalized, declarative, zero-token guards" is creative and well-differentiated. The README even names its closest competitor (`destructive_command_guard`, 5k stars) and draws the correct distinction: universal blocklist vs. learned-from-your-history guards. "Guards are declarative data, never executable code; trusted runtime actions perform every effect" is a clean, security-aware architecture. Not a category invention (blockers/hooks exist), but a real, non-obvious recombination → 8.

## 5. Overall Hackathon Readiness — 6/10

The hard 80% (a working, novel, demoable product) is done. The easy-but-fatal 20% (a runnable, honest, eligible submission) is not. Three self-inflicted holes keep this out of contention as-is.

### Top 3 fixes before submission

1. **Fill the Codex session ID — `README.md:127` literally says `TBD`.** The README calls this "required for eligibility." A blank required field is a disqualification risk and simultaneously the weakest link in the #1 rubric criterion. Paste the real core-build Codex session ID.
2. **Stop advertising a signed release that doesn't exist.** `release/metadata.json` is tracked and points at `release/vibebloat.pub` and `release/vibebloat-windows-x64.bundle` — **neither exists on disk** (only `release/vibebloat.key` and a gitignored `dist/vibebloat-windows-x64.exe` are present). `README.md:83-85` claims the binary is "Sigstore-signed… verified on every `vibebloat init`," while `INSTALL.md:3` honestly admits "no signed public binary yet." Fix the contradiction: either produce+commit the `.pub`/`.bundle` and publish the exe, or delete the signed-release claims. Right now `controlled-release.ts` verification (`sigstore.ts:41` requires all three files exist) cannot pass.
3. **Make it runnable by a judge.** The repo is **private** and `npx vibebloat` is unpublished, so a judge's only entry is the Codespace/source path. Publish to npm (or make the repo public with a one-command run) so the advertised `npx vibebloat` and "Try it" flow actually work end to end for a stranger.

### Ship / No-ship

**NO-SHIP as-is** — but a *fast* fix. The engineering and the idea are genuinely competitive; the blockers are ~a day of honesty-and-packaging work, not more building. Fix the three items above and it flips to a confident ship.

---

**HACKATHON-WIN LIKELIHOOD (1st place): 38/100**
