import type { GatePrompt } from "./assist";

export type GateId =
  | "A0" | "A1" | "F0" | "B1" | "B1.missing" | "B1.ignore" | "D1" | "D1.1"
  | "E1" | "E1.1" | "E2" | "F1" | "F1b" | "F2" | "F2.1" | "F3" | "F4" | "F5" | "F6"
  | "SCAN" | "G-empty" | "I1" | "I-zero" | "J0" | "J1" | "J1-unsure" | "J-cluster" | "J2" | "J3"
  | "K" | "K-conflict" | "L1" | "M" | "N1" | "N2" | "O1" | "O2" | "O3" | "END";

export interface OnboardingContext {
  knowledgeToolsDetected?: boolean;
  historyLarge?: boolean;
  hasHermesOrOpenClaw?: boolean;
  hasHookConflict?: boolean;
  scanOutcome?: "found" | "empty" | "zero";
  staleSourceSelected?: boolean;
  declinedToolsRemaining?: number;
  reviewsRemaining?: number;
  reviewUncertain?: boolean;
  reviewOverlap?: boolean;
}

export type GateChoice = string | number;

const gates: Record<GateId, GatePrompt> = {
  A0: { question: "Hey — I'm VibeBloat. I'll look through your past coding sessions, find the mistakes your AI keeps making, and set up little tripwires so they can't happen again. One quick look now — about [EST] minutes — then I just run quietly in the background. Want to start?", options: [] },
  A1: { question: "First: should I protect just this project, or watch your work everywhere on this machine?", options: ["Just this project", "Everywhere (recommended for solo devs)"] },
  F0: { question: "To catch mistakes I need to add two small helpers — a shortcut that watches commands, and a git safety check. Both are easy to remove any time. Okay to set those up?", options: ["Yes", "Tell me more first"] },
  B1: { question: "Let me see what you're working with. I found these on your machine: [Claude Code, Codex, Cursor, Hermes]. Did I get them all?", options: ["That's everything", "You missed one", "Ignore some of these"] },
  "B1.missing": { question: "Which, and where is it?", options: [] },
  "B1.ignore": { question: "Which should I leave out?", options: [] },
  D1: { question: "I can learn from your history in each of these. A couple look pretty old, so I left them unchecked — old mistakes may not matter anymore. Pull from these?", options: ["Use these", "Actually pull from everything", "Let me adjust"] },
  "D1.1": { question: "[Cursor] hasn't been touched in [94] days — its old mistakes might not apply. Include it anyway?", options: ["Yes", "No"] },
  E1: { question: "Want to make me smarter? I can connect the tools you already use. [CodeGraph → I'll know exactly which code a mistake touches] [Obsidian → I can point to your own notes] [your memory files → I won't repeat rules you already wrote]. Connect which?", options: ["Connect all (recommended)", "Connect selected", "Skip for now"] },
  "E1.1": { question: "Connecting [tool] lets me point to your own notes and code — sure you want to skip it?", options: ["Connect", "Skip"] },
  E2: { question: "You don't have a code map yet. I work much better with one — want me to install codebase-memory-mcp? (recommended)", options: ["Install it", "Not now"] },
  F1: { question: "Quick note on privacy: I read your old sessions right here on your computer — nothing gets uploaded. I hide any passwords or keys before I even look. And you approve every rule before it turns on. One optional thing: I can share the mistake patterns — never your code — to help protect other developers. It's on by default, but you can flip it off. Good to go?", options: ["Yes, sharing on", "Yes, but sharing off", "Cancel"] },
  F1b: { question: "Mind if I remember your answers to these setup questions — just the choices, never your code or secrets? It helps me make this smoother for everyone, now and when you come back. Totally optional.", options: ["Sure", "No thanks"] },
  F2: { question: "How should I do the scan? It's the one heavy step.", options: ["Just use this chat — you're already talking to me through [Claude Code], I'll run it right here, nothing to set up (recommended when agent-driven)", "Use my own API key", "Run it locally and free (a bit slower)"] },
  "F2.1": { question: "Here's the plan: [~1,450 sessions, about 8 minutes, free locally / ~$3 with your key]. When it's done I'll show you how much time these tripwires save you.", options: [] },
  F3: { question: "Your history is pretty big ([786 MB]) — a full deep look is about [35] minutes. How do you want it?", options: ["I'll wait, show me progress (recommended)", "Set up the important rules now, finish the deep part in the background"] },
  F4: { question: "Sometimes I won't be 100% sure a situation is risky. Should I stay quiet unless I'm sure (free), or double-check with AI when I'm unsure (costs a tiny bit)?", options: ["Stay quiet unless sure (recommended)", "Double-check with AI"] },
  F5: { question: "For rules about your coding style — should I use the preferences you've already written down, or figure out your style from your code?", options: ["Use what I've written (recommended)", "Figure it out from my code", "Skip style rules"] },
  F6: { question: "Want a free starter pack of rules every dev needs, plus a heads-up when I ship something big? Just your name, email, and what you're building — rare emails, no spam.", options: ["Yes", "Skip"] },
  SCAN: { question: "", options: [] },
  "G-empty": { question: "Looks like there's not much history here yet. I can start you with a pack of common safety rules and get smarter as you work. Want that?", options: ["Yes", "No"] },
  I1: { question: "I read [1,453] sessions and found [12] mistakes you've made more than once. Together they've cost you about [6.5] hours. Let's turn them into tripwires.", options: [] },
  "I-zero": { question: "Good news — I couldn't find mistakes you repeat. That's rare. Want a few common preventive rules anyway?", options: ["Yes", "No"] },
  J0: { question: "I've got [12]. Want to go through them one at a time, or should I switch on the [8] I'm confident about and you just review the [4] I'm unsure on?", options: ["One at a time", "Fast — turn on the confident ones, I'll review the rest"] },
  J1: { question: "Here's one. Back on [Jul 15], `git stash -u` wiped out some of your files. Want me to stop that from happening again? I'll step in only when it's actually risky, and you can always override it.", options: ["Yes, set it up", "Change it", "Skip", "That wasn't really a mistake"] },
  "J1-unsure": { question: "Not sure about this one — was it a real mistake? '[quote]'", options: ["Yes", "No"] },
  "J-cluster": { question: "A few of these overlap or could clash. Want me to combine them into one cleaner rule? (recommended)", options: ["Combine", "Keep separate"] },
  J2: { question: "Block or just warn? · What should it say when it steps in? · Which tools should it apply to? · On or off?", options: [] },
  J3: { question: "Want to share this rule with the community so it helps other devs? I only send the rule itself — never your code, file paths, or secrets.", options: ["Yes", "No", "Stop asking this time"] },
  K: { question: "", options: [] },
  "K-conflict": { question: "You've already got a [git pre-commit hook]. I'll add mine right alongside it — I won't touch yours.", options: ["Keep both (recommended)", "Let me handle it"] },
  L1: { question: "Want to watch one in action? I'll have an agent try `git stash -u` right now.", options: ["Yes", "Skip"] },
  M: { question: "All set. These tripwires block about [6.5] hours a [year] of repeat mistakes, cost nothing to run, and work across [Claude Code, Codex, Hermes].", options: [] },
  N1: { question: "VibeBloat is free. A GitHub star unlocks the community library — rules other developers have already built and shared. Star it?", options: ["Star", "Maybe later"] },
  N2: { question: "Working on a team? A shared rule library, CI checks, and a dashboard are coming. Want a heads-up when they land?", options: ["Yes, notify me (uses your email)", "Skip"] },
  O1: { question: "Want me to run a quick daily check that keeps your rules healthy and turns any new mistakes into tripwires automatically? (recommended)", options: ["Yes", "Manual only"] },
  O2: { question: "You run [Hermes] — want a daily background job to keep your rules current there too? (recommended)", options: ["Yes", "No"] },
  O3: { question: "When there's an update, should I just let you know with a one-command install, or update automatically (with an undo if anything breaks)?", options: ["Just let me know (recommended)", "Auto-update with rollback"] },
  END: { question: "You're all set. I'll keep watch 24/7 for free. Run `vibebloat doctor` any time to check on things, or `vibebloat rules` to manage them. Everything lives in `.vibebloat/`.", options: [] },
};

export function getGate(gate: GateId): GatePrompt {
  return gates[gate];
}

/** A free-form ASSIST message must not accidentally choose a locked option. */
export function isGateChoice(gate: GateId, choice: GateChoice): boolean {
  const prompt = getGate(gate);
  if (prompt.options.length === 0) return true;
  if (typeof choice === "number") return Number.isInteger(choice) && choice >= 0 && choice < prompt.options.length;
  const value = choice.trim().toLowerCase();
  return prompt.options.some((option, index) => option.toLowerCase() === value || value === String(index + 1) || value === String.fromCharCode(97 + index));
}

export function canonicalGateChoice(gate: GateId, choice: GateChoice): string {
  const options = getGate(gate).options;
  if (typeof choice === "number") return options[choice] ?? String(choice);
  const index = /^[a-z]$/i.test(choice) ? choice.toLowerCase().charCodeAt(0) - 97 : Number(choice) - 1;
  return Number.isInteger(index) && options[index] ? options[index] : choice;
}

export function autoAdvances(gate: GateId): boolean {
  return new Set<GateId>(["A0", "F2.1", "SCAN", "I1", "K", "M"]).has(gate);
}

function selected(choice: GateChoice, option: number, ...words: string[]): boolean {
  const value = String(choice).trim().toLowerCase();
  return choice === option || value === String(option + 1) || value === String.fromCharCode(97 + option) || words.some((word) => value === word);
}

function nextReview(context: OnboardingContext): GateId {
  return (context.reviewsRemaining ?? 1) > 1 ? "J1" : "K";
}

/** Locked first-run transition table. Caller performs side effects before advancing. */
export function nextFirstRunGate(gate: GateId, choice: GateChoice, context: OnboardingContext = {}): GateId | "CANCELLED" | undefined {
  switch (gate) {
    case "A0": return "A1";
    case "A1": return "F0";
    case "F0": return selected(choice, 0, "yes") ? "B1" : "F0";
    case "B1": return selected(choice, 0, "everything", "confirmed") ? "D1" : selected(choice, 1, "missing") ? "B1.missing" : "B1.ignore";
    case "B1.missing": case "B1.ignore": return "B1";
    case "D1":
      if (selected(choice, 2, "adjust")) return "D1";
      return context.staleSourceSelected ? "D1.1" : context.knowledgeToolsDetected ? "E1" : "E2";
    case "D1.1": return context.knowledgeToolsDetected ? "E1" : "E2";
    case "E1":
      if (selected(choice, 0, "all")) return "F1";
      return (context.declinedToolsRemaining ?? 1) > 0 ? "E1.1" : "F1";
    case "E1.1": return (context.declinedToolsRemaining ?? 1) > 1 ? "E1.1" : "F1";
    case "E2": return "F1";
    case "F1": return selected(choice, 2, "cancel") ? "CANCELLED" : "F1b";
    case "F1b": return "F2";
    case "F2": case "F2.1": return gate === "F2" ? "F2.1" : context.historyLarge ? "F3" : "F4";
    case "F3": return "F4";
    case "F4": return "F5";
    case "F5": return "F6";
    case "F6": return "SCAN";
    case "SCAN": return context.scanOutcome === "empty" ? "G-empty" : context.scanOutcome === "zero" ? "I-zero" : "I1";
    case "G-empty": return "N1";
    case "I1": return "J0";
    case "I-zero": return selected(choice, 0, "yes") ? "J0" : "N1";
    case "J0": return context.reviewOverlap ? "J-cluster" : context.reviewUncertain ? "J1-unsure" : "J1";
    case "J1": return selected(choice, 0, "yes") ? "J3" : selected(choice, 1, "change") ? "J2" : nextReview(context);
    case "J1-unsure": return selected(choice, 0, "yes") ? "J1" : nextReview(context);
    case "J-cluster": return "J1";
    case "J2": return "J1";
    case "J3": return nextReview(context);
    case "K": return context.hasHookConflict ? "K-conflict" : "L1";
    case "K-conflict": return "L1";
    case "L1": return "M";
    case "M": return "N1";
    case "N1": return "N2";
    case "N2": return "O1";
    case "O1": return context.hasHermesOrOpenClaw ? "O2" : "O3";
    case "O2": return "O3";
    case "O3": return "END";
    case "END": return undefined;
  }
}

/** Compatibility wrapper for the original A1/F0-only API. */
export function nextGate(gate: "A1" | "F0", answer: string): GateId {
  return nextFirstRunGate(gate, answer) as GateId;
}

export function renderGate(gate: GateId, values: Record<string, string | number> = {}): GatePrompt {
  const render = (value: string) => value.replace(/\[([^\]]+)\]/g, (match, name) => String(values[name] ?? match));
  const prompt = getGate(gate);
  return { question: render(prompt.question), options: prompt.options.map(render) };
}
