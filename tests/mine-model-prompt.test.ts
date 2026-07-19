import { expect, test } from "bun:test";
import { serializeModelCommandInput, buildChatCompletionsBody, parseModelIncidentOutput, usesChatCompletionsWire } from "../src/mine/model-command-input";
import type { HistoryChunk } from "../src/ingest/types";

const candidates: HistoryChunk[] = [
  { source: "claude-code", sessionId: "s1", messageIndex: 0, chunkIndex: 0, role: "user", content: "omfg git stash -u deleted my launchers" },
];

test("the model is told what to produce, not just handed raw data", () => {
  const input = serializeModelCommandInput(candidates);
  // Without a schema the model cannot know to emit these fields.
  for (const field of ["incident_id", "args_contains", "remediation", "chokepoint", "severity"]) {
    expect(input).toContain(field);
  }
  expect(input).toContain("omfg git stash -u deleted my launchers");
});

test("the OpenAI route sends a valid chat completions request", () => {
  const body = JSON.parse(buildChatCompletionsBody(serializeModelCommandInput(candidates)));
  expect(typeof body.model).toBe("string");
  expect(Array.isArray(body.messages)).toBe(true);
  expect(body.messages.length).toBeGreaterThan(0);
  // A bare {"candidates":[...]} body is rejected by the API with a 400.
  expect(body.candidates).toBeUndefined();
});

test("model output is read whether or not it is wrapped in prose or fences", () => {
  const manifest = [{ incident_id: "a", class: "A", chokepoint: "shell", command: "git stash", condition: "c", evidence_refs: [], severity: 5, frequency: 2, recency: "2026-07-15" }];
  const json = JSON.stringify(manifest);

  expect(parseModelIncidentOutput(json)).toHaveLength(1);
  expect(parseModelIncidentOutput("```json\n" + json + "\n```")).toHaveLength(1);
  expect(parseModelIncidentOutput("Here is what I found:\n\n" + json + "\n\nHope that helps.")).toHaveLength(1);
  // An OpenAI chat completion envelope carries the JSON in a message.
  expect(parseModelIncidentOutput(JSON.stringify({ choices: [{ message: { content: json } }] }))).toHaveLength(1);
});

test("unparseable model output is rejected rather than guessed at", () => {
  expect(() => parseModelIncidentOutput("I could not find any incidents, sorry!")).toThrow();
});

test("an empty finding is a valid answer", () => {
  expect(parseModelIncidentOutput("[]")).toEqual([]);
});

test("the OpenAI model id can be overridden without editing code", () => {
  const body = JSON.parse(buildChatCompletionsBody(serializeModelCommandInput(candidates), "gpt-4.1"));
  expect(body.model).toBe("gpt-4.1");
});

test("chat-completions routes are detected on any host or path", () => {
  for (const url of [
    "https://api.openai.com/v1/chat/completions",
    "https://openrouter.ai/api/v1/chat/completions",
    "http://localhost:8080/chat/completions",
  ]) {
    expect(usesChatCompletionsWire(["curl", url], {})).toBe(true);
  }
  expect(usesChatCompletionsWire(["ollama", "run", "llama3.1"], {})).toBe(false);
});

test("an unrecognized endpoint can be told which wire format to use", () => {
  const command = ["curl", "https://example.test/inference"];
  expect(usesChatCompletionsWire(command, {})).toBe(false);
  expect(usesChatCompletionsWire(command, { VIBEBLOAT_MODEL_WIRE: "chat-completions" })).toBe(true);
  // An explicit raw setting wins over URL sniffing.
  expect(usesChatCompletionsWire(["curl", "https://api.openai.com/v1/chat/completions"], { VIBEBLOAT_MODEL_WIRE: "raw" })).toBe(false);
});
