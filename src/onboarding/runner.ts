import { getGate, isGateChoice, nextFirstRunGate, type GateChoice, type GateId, type OnboardingContext } from "./gates";

export function nextGateBatch<Gate>(orderedGates: Gate[], offset: number, maximum = 3): Gate[] {
  if (maximum < 1 || maximum > 3) throw new Error("Onboarding gate batch must contain one to three gates.");
  return orderedGates.slice(offset, offset + maximum);
}

export interface RunnerState {
  gate: GateId;
  answers: Record<string, string>;
  cancelled?: boolean;
}

/** Pure runner: UI owns discovery, scanning, installs, and every human choice. */
export class OnboardingRunner {
  constructor(private state: RunnerState, private readonly context: OnboardingContext = {}) {}

  current() { return getGate(this.state.gate); }

  snapshot(): RunnerState { return { ...this.state, answers: { ...this.state.answers } }; }

  choose(choice: GateChoice): RunnerState {
    if (!isGateChoice(this.state.gate, choice)) return this.snapshot();
    const next = nextFirstRunGate(this.state.gate, choice, this.context);
    this.state.answers[this.state.gate] = String(choice);
    if (next === "CANCELLED") this.state.cancelled = true;
    else if (next) this.state.gate = next;
    return this.snapshot();
  }
}
