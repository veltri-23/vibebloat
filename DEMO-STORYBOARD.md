# VibeBloat Demo Storyboard

**Target length:** 2:30–2:50
**Visual system:** light mode, IBM Plex, burnt orange (`#c44601`), clean terminal and caption overlays. No emoji. Never show raw JSON.

## Shot 1 — Agent-narrated onboarding (0:00–0:35)

**Picture:** A fresh Claude Code session starts VibeBloat onboarding. The agent answers the prompts in plain language while the terminal shows the rendered questions and choices.

**Narration:** “VibeBloat asks where to watch, explains that history stays local and secrets are scrubbed before analysis, then asks how to run the scan. I’m choosing the agent-driven path: Claude Code runs the initialization and narrates each decision.”

**On-screen beats:** The scan plan is described as a short review of local session history; the agent selects the recommended privacy-preserving choices. Show the rendered onboarding copy, not the internal gate identifiers or serialized payloads.

**Caption:** “Onboarding is agent-driven: one rule, one agent, one shared enforcement path.”

## Shot 2 — From repeated incident to approved guard (0:35–1:05)

**Picture:** The scan summary appears as normal prose. The agent reviews the repeated incident and approves a rule.

**Narration:** “The system reads the local session history, finds the destructive command recurring, and turns that evidence into a proposed tripwire. I review the incident and approve the guard; the guard records the safer alternative: scope the stash to a path or commit first.”

**On-screen beats:** Show a concise summary such as “Repeated incident found: untracked operational files were removed.” Show the human approval step and the resulting rule description. Do not expose the source paths, secrets, gate IDs, or raw machine-readable records.

**Caption:** “History is scrubbed, mined, reviewed, then compiled only after approval.”

## Shot 3 — Kill shot: deterministic `git stash -u` block (1:05–1:35)

**Picture:** In the same live repository, leave an untracked fixture file visible. A fresh Claude Code command attempts `git stash -u`.

**Narration:** “Now the kill shot. Claude Code tries `git stash -u` in a tree with untracked work. The shared matcher recognizes the Git subcommand and stops the command before it can remove those files.”

**On-screen beats:** The terminal shows the command denied with exit code 2 and the human-readable remediation: “Use `git stash -u -- <path>` or commit first.” Immediately run the safe, path-scoped variant to show that VibeBloat is precise, not a blanket Git block.

**Caption:** “Blocked before data loss. Safe scoped variant still runs.”

## Shot 4 — Bonus beat: live compile from `git clean -fd` (1:35–2:05)

**Picture:** In a disposable demo directory, run the live incident path with `git clean -fd`. Keep the terminal visible so the interactive TTY requirement is clear.

**Narration:** “Bonus beat: the live-compile path watches a real destructive command. `git clean -fd` is detected from the before-and-after tree, then the compiler validates a guard against a synthetic event, atomically writes the guard, and writes a passing proof. This path needs an interactive terminal; it is a live demonstration, not a pre-installed storyboard block.”

**On-screen beats:** Show the command in the terminal, the observed untracked-file change, the words “guard compiled” and “proof passed,” and the new rule appearing in the local guard directory. Keep generated proof summarized in captions rather than opening its JSON.

**Caption:** “Live compile is a bonus: observe, validate, write atomically, prove.”

## Shot 5 — Cross-agent proof (2:05–2:40)

**Picture:** Start a separate Codex session with the same approved local guard. It attempts the same unscoped `git stash -u` command.

**Narration:** “Finally, a different agent, in a fresh session that never saw the original incident, hits the same guard. Claude Code and Codex reach the same matcher through different agent chokepoints, so the receipt is consistent and the destructive command is denied again.”

**On-screen beats:** Show the second denial and the same remediation, then show the safe scoped command succeeding. End on the clean caption: “One approved rule. Multiple agents. One enforcement decision.”

**Caption:** “Cross-agent binding is the proof, not a second scripted demo.”

## Filming notes

- Keep the full cut under three minutes; trim pauses between onboarding answers.
- Burn in captions for the narration and the key terminal outcomes.
- Use the real terminal output from the current build. Do not film raw JSON, internal gate names, placeholder counts, or emoji.
- If the live-compile terminal setup is not stable on camera, keep Shot 4 as a clearly labeled bonus and preserve Shots 1, 3, and 5 as the required proof path.
