import { expect, test } from "bun:test";
import { parseModelIncidentOutput } from "../src/mine/model-command-input";

const manifest = [{
  incident_id: "a", class: "A", chokepoint: "shell", command: "git stash",
  condition: "c", evidence_refs: [], severity: 5, frequency: 2, recency: "2026-07-15",
}];

// `ollama run` writes a progress spinner to stdout even when piped, so the
// advertised free local route returned escape codes wrapped around the JSON
// and every local scan failed. Found by dogfooding against real history.
const ESC = String.fromCharCode(27);
const spinner = `${ESC}[?2026h${ESC}[?25l${ESC}[1G⣙ ${ESC}[K${ESC}[?25h${ESC}[?2026l`;

test("terminal control sequences around the output are ignored", () => {
  expect(parseModelIncidentOutput(`${spinner}${JSON.stringify(manifest)}${spinner}`)).toHaveLength(1);
});

test("a carriage-return progress line before the JSON is ignored", () => {
  expect(parseModelIncidentOutput(`loading\r100%\r\n${JSON.stringify(manifest)}`)).toHaveLength(1);
});

test("a spinner with no JSON is still a clear failure", () => {
  expect(() => parseModelIncidentOutput(`${spinner}`)).toThrow(/JSON incident array/);
});

test("control characters inside JSON strings do not corrupt the manifest", () => {
  const withText = [{ ...manifest[0]!, condition: "line one" }];
  expect(parseModelIncidentOutput(`${spinner}${JSON.stringify(withText)}`)[0]).toMatchObject({ condition: "line one" });
});
