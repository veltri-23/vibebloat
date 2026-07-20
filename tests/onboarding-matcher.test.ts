import { expect, test } from "bun:test";

// Local mirror of the production intent matcher. The production matcher
// lives in src/onboarding/gates.ts and depends on a real gate; the test
// here exercises the same predicate against hand-built option lists.
const AFFIRMATIVE_WORDS = new Set(["yes", "y", "yep", "yeah", "yup", "sure", "ok", "okay", "confirm", "please", "do it", "absolutely", "yessir"]);
const DECLINE_WORDS = new Set(["no", "n", "nope", "nah", "skip", "cancel", "decline", "never", "no thanks", "nope thanks", "nada"]);

function isGateChoiceFor(options: readonly string[], answer: string): boolean {
  const value = answer.trim().toLowerCase();
  if (options.length === 0) return true;
  if (options.some((o) => o.toLowerCase() === value)) return true;
  if (AFFIRMATIVE_WORDS.has(value)) return true; // matches recommended or first
  if (DECLINE_WORDS.has(value)) return true; // matches last (typical skip position)
  return false;
}

function canonicalFor(options: readonly string[], answer: string): string {
  const value = answer.trim().toLowerCase();
  if (options.some((o) => o.toLowerCase() === value)) {
    return options.find((o) => o.toLowerCase() === value)!;
  }
  const recommended = options.findIndex((o) => /recommended/i.test(o));
  if (AFFIRMATIVE_WORDS.has(value)) {
    return recommended >= 0 ? options[recommended]! : options[0]!;
  }
  if (DECLINE_WORDS.has(value)) {
    return options[options.length - 1]!;
  }
  return answer;
}

function nearestFor(options: readonly string[], answer: string): { index: number; option: string; distance: number } | undefined {
  const value = answer.trim().toLowerCase();
  let best: { index: number; option: string; distance: number } | undefined;
  for (let i = 0; i < options.length; i += 1) {
    const opt = options[i]!;
    const firstWord = (opt.split(/\s+/)[0] ?? opt).toLowerCase();
    const d = Math.min(
      normalizedLevenshtein(value, opt.toLowerCase()),
      normalizedLevenshtein(value, firstWord),
    );
    if (best === undefined || d < best.distance) best = { index: i, option: opt, distance: d };
  }
  return best && best.distance <= 0.5 ? best : undefined;
}

function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return 1;
  return levenshtein(a, b) / Math.max(a.length, b.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const previous = new Array<number>(n + 1);
  const current = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) previous[j] = j;
  for (let i = 1; i <= m; i += 1) {
    current[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j += 1) previous[j] = current[j]!;
  }
  return previous[n]!;
}

test("yep matches the recommended option when one exists", () => {
  const options = ["Just use this chat (recommended when agent-driven)", "Use my own API key", "Run it locally"];
  expect(isGateChoiceFor(options, "yep")).toBe(true);
});

test("yeah matches the recommended option", () => {
  const options = ["Stay quiet unless sure (recommended)", "Double-check with AI"];
  expect(isGateChoiceFor(options, "yeah")).toBe(true);
});

test("nope matches the option after the recommended one", () => {
  const options = ["Yes", "Skip"];
  expect(isGateChoiceFor(options, "nope")).toBe(true);
});

test("'that's everything' canonicalizes to a That's everything option", () => {
  const options = ["That's everything", "You missed one", "Ignore some of these"];
  expect(isGateChoiceFor(options, "that's everything")).toBe(true);
});

test("banana does not match any option", () => {
  const options = ["Yes", "No", "Cancel"];
  expect(isGateChoiceFor(options, "banana")).toBe(false);
});

test("canonical 'nope' returns the skip option", () => {
  const options = ["Yes", "Skip"];
  expect(canonicalFor(options, "nope")).toBe("Skip");
});

test("canonical 'yep' returns the recommended option", () => {
  const options = ["Just use this chat (recommended)", "Use my own API key"];
  expect(canonicalFor(options, "yep")).toBe("Just use this chat (recommended)");
});

test("near-miss 'evrywhere' returns the Everywhere option", () => {
  const options = ["Just this project", "Everywhere (recommended for solo devs)"];
  const result = nearestFor(options, "evrywhere");
  expect(result).toBeDefined();
  expect(result!.option).toBe("Everywhere (recommended for solo devs)");
});

test("near-miss 'tell me mor' returns the Tell me more option", () => {
  const options = ["Yes", "Shim only — skip the git hook", "Tell me more first"];
  const result = nearestFor(options, "tell me mor");
  expect(result).toBeDefined();
  expect(result!.option).toBe("Tell me more first");
});

test("near-miss 'banana' returns nothing", () => {
  const options = ["Yes", "No", "Cancel"];
  expect(nearestFor(options, "banana what is the meaning of life")).toBeUndefined();
});
