import { expect, test } from "bun:test";
import { gitStashUntrackedGuard } from "../src/guards";
import { match } from "../src/match";

test("tier-1 keyword misses avoid AST work within the hot-path budget", () => {
  const samples: number[] = [];
  for (let index = 0; index < 2_000; index += 1) {
    const started = performance.now();
    const verdict = match(gitStashUntrackedGuard, { chokepoint: "shell", command: "echo harmless" });
    samples.push(performance.now() - started);
    expect(verdict).toEqual({ fired: false });
  }
  samples.sort((left, right) => left - right);
  const p99 = samples[Math.floor(samples.length * 0.99)];
  expect(p99).toBeLessThan(1);
});
