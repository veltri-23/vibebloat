import { expect, test } from "bun:test";
import { detectRunner } from "../src/onboarding/detect-runner";

test("explicit flag overrides automatic runner detection", () => {
  expect(detectRunner({ explicit: "human", isTTY: false, env: { CODEX_HOME: "x" }, parentProcess: "codex" })).toBe("human");
});

test("agent environment and parent process detect an agent runner", () => {
  expect(detectRunner({ isTTY: true, env: { CLAUDE_CODE_ENTRYPOINT: "cli" }, parentProcess: "powershell" })).toBe("agent");
  expect(detectRunner({ isTTY: true, env: {}, parentProcess: "codex" })).toBe("agent");
});

test("interactive TTY without agent signals detects a human runner", () => {
  expect(detectRunner({ isTTY: true, env: {}, parentProcess: "powershell" })).toBe("human");
});
