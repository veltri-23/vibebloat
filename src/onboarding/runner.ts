import { answerAssist, type AssistContext, type AssistResponse } from "./assist";
import type { RunnerKind } from "./detect-runner";
import { autoAdvances, canonicalGateChoice, gateValues, getGate, isGateChoice, nextFirstRunGate, renderGate, type GateChoice, type GateId, type OnboardingContext } from "./gates";
import type { GuardScope } from "../guard-home";

export function nextGateBatch<Gate>(orderedGates: Gate[], offset: number, maximum = 3): Gate[] {
  if (maximum < 1 || maximum > 3) throw new Error("Onboarding gate batch must contain one to three gates.");
  return orderedGates.slice(offset, offset + maximum);
}

export interface RunnerState {
  gate: GateId;
  answers: Record<string, string>;
  runner?: RunnerKind;
  scope?: GuardScope;
  cancelled?: boolean;
}

export interface RunnerOptions {
  save?(state: RunnerState): void;
}

/** Pure runner: UI owns discovery, scanning, installs, and every human choice. */
export class OnboardingRunner {
  constructor(
    private state: RunnerState,
    private readonly context: OnboardingContext = {},
    private readonly options: RunnerOptions = {},
    private values: Record<string, string | number> = gateValues(),
  ) {}

  /** Rendered with this machine's measurements, never raw placeholder copy. */
  current() { return renderGate(this.state.gate, this.values); }

  /** Scan results arrive mid-run, so measurements can be refreshed in place. */
  measure(values: Record<string, string | number>): void {
    this.values = { ...this.values, ...values };
  }

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
    if (!isGateChoice(this.state.gate, choice, this.values)) return this.snapshot();
    const gate = this.state.gate;
    const canonical = canonicalGateChoice(gate, choice, this.values);
    const optionIndex = getGate(gate).options.indexOf(canonical);
    const next = nextFirstRunGate(gate, optionIndex >= 0 ? optionIndex : choice, this.context);
    this.state.answers[gate] = canonical;
    if (gate === "A1") this.state.scope = this.state.answers[gate] === "Just this project" ? "repo" : "machine";
    if (next === "CANCELLED") return this.cancel();
    else if (next) this.state.gate = next;
    return this.snapshot();
  }
}
