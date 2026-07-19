import { expect, test } from "bun:test";
import { join } from "node:path";

const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

function demo(environment: Record<string, string | undefined> = {}) {
  return Bun.spawnSync(["bun", cliPath, "demo"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      // Strip every auto-detected model route so the path is deterministic.
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_CODE_SSE_PORT: undefined,
      CODEX_HOME: undefined,
      OPENCLAW_SESSION: undefined,
      HERMES_HOME: undefined,
      OPENAI_API_KEY: undefined,
      VIBEBLOAT_MODEL_COMMAND: undefined,
      VIBEBLOAT_LOCAL_MODEL_COMMAND: undefined,
      ...environment,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// The gap that let a ship-blocker through: every unit test checked structures,
// none checked what a judge actually reads on screen.
function assertEveryReceiptLineMarked(output: string) {
  const receiptLines = output.split("\n").filter((line) => /^(BLOCKED|WARNING|incident:|why:|fix:)/.test(line));
  expect(receiptLines.length).toBeGreaterThan(0);
  for (const line of receiptLines) expect(line.toLowerCase()).toContain("sample");
}

test("printed output marks every receipt line, with no model configured", () => {
  const result = demo();
  expect(result.exitCode).toBe(0);
  assertEveryReceiptLineMarked(result.stdout.toString());
});

test("printed output marks every receipt line when a model mines live", () => {
  const model = ["bun", "-e", `console.log(JSON.stringify([{
    incident_id: "docker-compose-down-volumes", class: "A", chokepoint: "shell",
    command: "docker compose", args_contains: ["down", "-v"],
    condition: "docker compose down -v destroyed the local dev database volume",
    remediation: "Use docker compose down without -v.",
    evidence_refs: ["sample-session-3:0"], severity: 5, frequency: 2, recency: "2026-07-19"
  }]))`];
  const result = demo({ VIBEBLOAT_MODEL_COMMAND: JSON.stringify(model) });

  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString();
  expect(output).toContain("mined live by your model");
  assertEveryReceiptLineMarked(output);
});

test("the sample label heads the output on every path", () => {
  expect(demo().stdout.toString()).toStartWith("SAMPLE DATA");
});
