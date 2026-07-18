import { answerAssist, type AssistContext, type AssistResponse } from "./assist";
import { autoAdvances, canonicalGateChoice, getGate, isGateChoice, nextFirstRunGate, type GateChoice, type GateId, type OnboardingContext } from "./gates";

export function nextGateBatch<Gate>(orderedGates: Gate[], offset: number, maximum = 3): Gate[] {
  if (maximum < 1 || maximum > 3) throw new Error("Onboarding gate batch must contain one to three gates.");
  return orderedGates.slice(offset, offset + maximum);
}

export interface RunnerState {
  gate: GateId;
  answers: Record<string, string>;
  cancelled?: boolean;
}

export interface RunnerOptions {
  save?(state: RunnerState): void;
}

/** Pure runner: UI owns discovery, scanning, installs, and every human choice. */
export class OnboardingRunner {
  constructor(private state: RunnerState, private readonly context: OnboardingContext = {}, private readonly options: RunnerOptions = {}) {}

  current() { return getGate(this.state.gate); }

  snapshot(): RunnerState { return { ...this.state, answers: { ...this.state.answers } }; }

  cancel(): RunnerState {
    this.state.cancelled = true;
    const snapshot = this.snapshot();
    this.options.save?.(snapshot);
    return snapshot;
  }

  advance(): RunnerState {
    if (!autoAdvances(this.state.gate)) return this.snapshot();
    // ponytail: SCAN stays pending until scan owner provides an outcome; runner never starts expensive work.
    if (this.state.gate === "SCAN" && !this.context.scanOutcome) return this.snapshot();
    const next = nextFirstRunGate(this.state.gate, "", this.context);
    if (next) this.state.gate = next;
    return this.snapshot();
  }

  advanceAutomaticGates(): RunnerState {
    while (autoAdvances(this.state.gate)) {
      const before = this.state.gate;
      this.advance();
      if (this.state.gate === before) break;
    }
    return this.snapshot();
  }

  assist(message: string, context: Omit<AssistContext, "question" | "options" | "applyRecommended">): AssistResponse {
    let applied: string | undefined;
    const response = answerAssist(message, {
      ...context,
      ...this.current(),
      applyRecommended: (choice) => { applied = choice; },
    });
    if (applied) this.choose(applied);
    return response;
  }

  choose(choice: GateChoice): RunnerState {
    if (typeof choice === "string" && choice.trim().toLowerCase() === "cancel") return this.cancel();
    if (!isGateChoice(this.state.gate, choice)) return this.snapshot();
    const next = nextFirstRunGate(this.state.gate, choice, this.context);
    this.state.answers[this.state.gate] = canonicalGateChoice(this.state.gate, choice);
    if (next === "CANCELLED") return this.cancel();
    else if (next) this.state.gate = next;
    return this.snapshot();
  }
}
