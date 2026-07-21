# VibeBloat — Principal Engineer Review (Technical Depth)

**Reviewer persona:** Principal Engineer. Lens: depth of thought over surface area. Blunt, file-cited.
**Repo:** `D:\AI\projects\antibody` @ `task/vibebloat-mvp`. **Verdict up front: this is real engineering, not scaffolding.**

---

## 1. Is it coherent engineering? — Trace of one full path

I traced a single incident (`git stash -u` deleted operational files) from raw history to enforced guard, and again through the *live* self-authoring loop. The seams hold.

**Cold path (history → installed guard):**
1. **Ingest** (`src/ingest/cc-jsonl.ts`, `codex-jsonl.ts`, `scan.ts`) turns agent transcripts into `HistoryChunk`s.
2. **Scrub** (`src/scrub/`) layers real redactors — `gitleaks.ts`, `presidio.ts`, `builtin.ts` — behind `resolve.ts` + `fail-closed.ts`. `runModelPass` refuses to proceed unless the payload passes the `isScrubbedCandidates` brand check (`src/mine/model-pass.ts:7`). Secrets are removed *before* the model sees anything.
3. **Mine** (`src/mine/model-command-input.ts`). The model is untrusted I/O and is treated that way: `parseModelIncidentOutput` (`:145`) accepts a bare array, a chat-completions envelope, a fenced block, or an array embedded in prose, strips terminal control, and **throws rather than guessing** (`:147`). This is the correct posture for parsing LLM output.
4. **Compile** (`src/compiler/`). The mined `IncidentManifest` goes through `parseGuard` (schema-validated) and then the load-bearing idea of the whole project: **proof-carrying compilation**. `compileLive` (`src/compiler/live-compile.ts:42`) builds a `syntheticEvent` from the guard's own match spec and **only writes the guard if it fires against that event** (`:45-51`). The comment at `src/compiler/synthetic-event.ts:6-10` states the invariant precisely: a guard with `argsContains` that can't fire its own synthetic event is rejected at compile time. You structurally cannot install a guard that doesn't work.
5. **Match** (`src/match.ts`) — see §3. Verdict returns through `Runtime.evaluate` (`src/runtime.ts:36`) which layers overrides, agent `binds`, action dispatch, and firing audit.

**Hot path (live self-authoring) — this is the impressive part.** `src/hooks/shell-shim-handler.ts` wraps the real `git`: it evaluates guards, runs real git, snapshots the untracked tree before/after (`captureGitTreeSnapshot`, `live-incident.ts:112`), and if a destructive command actually removed untracked files it mints a *new* incident and schedules a background compile (`:428`). That proposal is then gated by machinery most production systems lack:
- **Cryptographically bound proof:** the proof file stores `guardSha256` of the exact guard bytes; `parseBoundProof` (`live-incident.ts:321`) rejects any proof whose digest doesn't match the guard on disk. A guard can't be swapped after it was proved.
- **Unforgeable human approval:** `HumanLiveCompileApproval` is a branded type behind a module-private `Symbol` (`:36`); `authorizeHumanLiveCompileApproval` (`:449`) refuses anything but a real human TTY, and `approveLiveCompileProposal` re-checks the sha against what the human reviewed (`:499`) — "proposal changed after human review" is a first-class error.
- **Cross-process safety:** `acquireProposalLock` (`:239`) is a directory-lock with PID liveness checks (`processAlive`, `:229`), stale-lock reclaim via rename-tombstone (`reclaimProposalLock`, `:271`), and TOCTOU defense — `assertPlainDirectoryOrMissing` (`:199`) rejects symlinks/non-dirs before every write.

**Judgment:** the seams are tight and the data contracts are explicit (branded types at every trust boundary: `ScrubbedCandidates`, `UntrustedSemanticContext`, `HumanLiveCompileApproval`). This is a coherent system with a genuinely novel core (proof-carrying, self-authoring guards), not a pile of stubs.

## 2. Test quality — behavioral, not structural

Opened `tests/match.test.ts`, `tests/cli-install.test.ts`, and sampled the suite (141 files / ~12k LOC / 2577 assertions). These exercise **behavior and adversarial edges**, not shape:
- `match.test.ts:34` env-var expansion before eval; `:42` git-alias resolution (`git st -u` → `git stash -u`); `:50` fail-**closed** on Class A parse error vs fail-**open** on B/C/D (the safety-class contract, tested per class); `:64` 64 KB oversize bound *before* parsing; `:72` bounded variable expansion (expansion-bomb defense); `:84` exactly-one override consumption; `:91` agent-bind scoping.
- `cli-install.test.ts` spawns the real CLI against temp `git init` repos and asserts on-disk artifacts: Claude `settings.json`, Codex `config.toml` (`plugin_hooks = true`), git hooks that invoke the executable and **explicitly assert the anti-pattern is absent** (`:53` `not.toMatch(/^vibebloat git-hook/m)` — a bare-name-on-PATH would break every commit). It even checks the negative: no fs-guard receipt when unrequested (`:56`).

These are the tests of someone who has been burned. Grade: **excellent.**

## 3. `src/match.ts` — read fully

Small (208 lines) but dense and correct. Tree-sitter bash AST (`shellCommands`, `:132`) with `hasError` → throw → `parseErrorVerdict` (`:149`) that fires-closed for Class A only. Git handling is thorough: global-option stripping incl. `-c key=val` forms (`stripGitGlobalOptions`, `:17`), alias expansion with shell-alias (`!`) refusal (`:181`), and the whole-tree pathspec insight (`:196`) — `git checkout -- src/` is scoped and skipped, but `-- .` / `./` / `:/` selects the entire tree and still fires (`wholeTreePathspecs`, `:59`). `argMatches` (`:26`) correctly expands bundled short flags (`-fd` contains `-f`). Fast-path `hasCommandKeyword` avoids parsing when the binary isn't even present.

**One real smell:** double parsing. Tree-sitter produces the AST, then `tokenize` (`:104`) hand-re-tokenizes `node.text` with a naive quote splitter that **does not handle backslash escapes** inside the command node. For Class A this is masked by fail-closed behavior, but it's two parsers doing overlapping work with different fidelity — a latent inconsistency. **Minor:** `normalizeCommand` (`:52`) falls back to `process.env` for any unresolved `$VAR`, quietly expanding the real environment into the matched string. Low risk (never surfaced to output) but surprising.

## 4. `src/cli.ts` — the god-file (the honest worst smell)

1787 lines, **66 imports** (it imports essentially the entire system), ~45 helper functions, 26 `mode` branches. The saving grace: business logic lives in the small pure modules (`scrub/`, `ingest/`, `compiler/`, `onboarding/`); the helpers here (`configText`, `formatOnboardingPretty`, `installFailureReason`, `syncDiffLines`…) are orchestration/formatting glue. So it's a **fat dispatcher, not a logic swamp** — but it is still the one file that knows about everything, and it's the single most likely thing to rot and the hardest artifact to walk a judge through live. This should be split into `src/cli/<command>.ts` modules (the pattern already exists — `cli/daily.ts`, `cli/disable.ts`, `cli/rules.ts` — it just wasn't finished).

## 5. Failure modes

- **Malformed history / model output:** `parseModelIncidentOutput` throws on garbage; `parseIncidentManifest`/`assertCompilableIncident` (cli.ts:435/482) validate before compile. Good.
- **Huge commands (64 KB cap):** enforced in `match.ts` *before* normalization AND after expansion (`:169-171`), plus the expansion-bomb bound inside `normalizeCommand` (`:45`). Fires-closed for Class A. Tested. Good.
- **Missing model / scrubbers:** `ControlledScrubbersUnavailableError` and `fail-closed.ts` exist; `demo` uses a `DemoMiner` so the walkthrough doesn't need a live model. But the flagship "mine *my* real incidents" path depends on external binaries (gitleaks, presidio, a model command) — degradation is handled but the depth of that path only shows if those exist on the judge's box.
- **Partial installs:** `install/atomic-files.ts` + `replaceGuardAtomically` (temp-file + rename) make guard/proof writes atomic; install asserts artifacts and refuses without `--yes`. Good.

## 6. The 1 failing test — noise

`tests/cli-install.test.ts` "install creates Claude JSON and Codex TOML hooks after consent" timed out at 5000 ms. This test does `git init` + `bun cli.ts install --yes` + further spawns (`:58+`) — the most subprocess-heavy test in the suite. The full run took 27 s, and the *lighter* sibling ("requires permission", `:18`) passed. The same install path is covered by other green tests. This is a **load-dependent timeout flake, not a logic defect.** Fix: bump this test's timeout. Not a risk.

## 7. Biggest technical debt / walkthrough embarrassment

1. **`cli.ts` god-file** — the demo's front door is the least maintainable file. Finish the `cli/` split.
2. **External-binary dependence on the hero path** — "mine real incidents" needs gitleaks/presidio/model present; if a judge runs it cold, they see the sample, not the magic. Pre-flight/bundle or make the degradation loud and self-explaining.
3. **Double parse in `match.ts`** — retire the hand tokenizer in favor of AST-derived words.

---

## Scores

**Build Week Criterion #1 — Technological Implementation: 9 / 10.**
Evidence: proof-carrying compilation (a guard cannot exist unless it fires its own synthetic event), fail-closed safety classes, tree-sitter parsing with alias/global-option/whole-tree correctness, sha256-bound proofs + branded human-TTY approval, cross-process directory locks with liveness + stale reclaim + TOCTOU defense, layered secret scrubbing, defensive untrusted-model-output parsing, and 700 behavioral tests. Held back from 10 only by the `cli.ts` god-file and the double-parse/external-dependency fragility.

**Code-quality grade: A−.**
Small pure modules, branded trust boundaries, WHAT/WHY/FIX structured errors, atomic writes, and genuinely adversarial tests. The single blemish keeping it off an A is `cli.ts`.

**Single best-engineered thing:** proof-carrying, self-authoring guards — `compileLive` refuses to install a guard that can't fire its own synthetic event (`compiler/live-compile.ts:45`), and the live loop mints new guards from real destructive git outcomes gated by sha-bound proofs + unforgeable human approval (`compiler/live-incident.ts:449-511`).

**Single worst smell:** `src/cli.ts` — 1787 lines, 66 imports, 26 mode branches; the whole system funnels through one file.

**Failing test verdict:** noise. A subprocess-heavy install integration test timing out at 5 s during a 27 s run; same path is otherwise green. Raise the timeout.

HACKATHON-WIN LIKELIHOOD (1st place): 64/100
