import { match } from "./match";
import type { Event, Guard, Verdict } from "./types";

export class Runtime {
  private readonly overrides = new Set<string>();

  allowOnce(guardId: string): void {
    this.overrides.add(guardId);
  }

  evaluate(guards: Guard[], event: Event): Verdict {
    for (const guard of guards) {
      const verdict = match(guard, event);
      if (!verdict.fired) continue;
      if (this.overrides.delete(guard.id)) return { fired: false };
      return verdict;
    }
    return { fired: false };
  }
}
