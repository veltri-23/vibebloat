import { isUntrustedSemanticContext, type UntrustedSemanticContext } from "../ingest/semantic-context";
import type { HistoryChunk } from "../ingest/types";

/**
 * Model used when the OpenAI route builds its own request body. Overridable
 * via VIBEBLOAT_OPENAI_MODEL: a wrong id here would otherwise make the
 * advertised zero-config OPENAI_API_KEY route fail with no way out.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.6";

export function openAiModel(environment: Record<string, string | undefined> = process.env): string {
  return environment.VIBEBLOAT_OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
}

/**
 * Whether this command speaks the chat-completions wire format and therefore
 * needs a real request body rather than the raw mining payload.
 *
 * Detection is by URL because that is all a command line reveals; any endpoint
 * it cannot recognize can be declared with VIBEBLOAT_MODEL_WIRE, which wins
 * over sniffing in both directions.
 */
export function usesChatCompletionsWire(
  command: readonly string[],
  environment: Record<string, string | undefined> = process.env,
): boolean {
  const declared = environment.VIBEBLOAT_MODEL_WIRE?.trim().toLowerCase();
  if (declared === "chat-completions") return true;
  if (declared === "raw") return false;
  return command.some((part) => part.includes("chat/completions"));
}

/**
 * The mining contract.
 *
 * Two fields carry the product: `args_contains`, without which an incident
 * compiles to a guard that blocks the whole command ("git stash -u deleted my
 * files" becoming a rule against every git stash), and `remediation`, which is
 * the line the user reads at block time.
 */
const INSTRUCTIONS = `You are reading a developer's own AI-agent chat history to find mistakes that
repeat, so each one can be compiled into a deterministic guard.

Return ONLY a JSON array. No prose, no code fences. An empty array [] is a
valid and expected answer when nothing repeats.

Each element:
{
  "incident_id": "kebab-case-id",         // stable, descriptive, e.g. git-stash-untracked
  "class": "A" | "B" | "C" | "D",         // A destructive | B bad edit/config | C environment | D wrong result
  "chokepoint": "shell" | "file",
  "command": "git stash",                 // shell only: binary + subcommand, NO flags
  "args_contains": ["-u"],                // shell only: the flags that made it destructive. REQUIRED when
                                          // the bare command is safe. Omit only if the command is always unsafe.
  "path": "config/.mcp.json",             // file only: repository-relative, never absolute
  "condition": "git stash -u deleted untracked launcher scripts",
  "remediation": "Use git stash -u -- <path>, or commit first.",  // what to do instead, one sentence
  "evidence_refs": ["<sessionId>:<messageIndex>"],
  "severity": 1-5,
  "frequency": 2,                         // how many times it actually happened in this history
  "recency": "YYYY-MM-DD"                 // most recent occurrence
}

Rules:
- Only report something that happened MORE THAN ONCE, or once with severe loss.
- A user swearing is not itself an incident. Report what the agent or the user
  actually broke.
- Never include secrets, absolute paths, or personal data in any field.
- args_contains matters: without it the guard blocks every use of the command
  and the user turns it off.`;

export function serializeModelCommandInput(
  candidates: readonly HistoryChunk[],
  semanticContext?: UntrustedSemanticContext,
): string {
  if (semanticContext !== undefined && !isUntrustedSemanticContext(semanticContext)) {
    throw new Error("Model command requires validated semantic context");
  }
  return JSON.stringify({
    instructions: INSTRUCTIONS,
    candidates,
    ...(semanticContext ? { semantic_context: semanticContext } : {}),
  });
}

/**
 * The OpenAI route pipes its stdin straight to /v1/chat/completions, which
 * rejects a bare {"candidates":[...]} payload, so the request body has to be
 * assembled here.
 */
export function buildChatCompletionsBody(serializedInput: string, model = openAiModel()): string {
  const parsed = JSON.parse(serializedInput) as { instructions?: string; candidates?: unknown; semantic_context?: unknown };
  const { instructions, ...payload } = parsed;
  return JSON.stringify({
    model,
    messages: [
      { role: "system", content: instructions ?? INSTRUCTIONS },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });
}

function firstJsonArray(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/**
 * Reads the manifest out of whatever the model actually returned: a bare
 * array, a fenced block, an array surrounded by prose, or a chat-completions
 * envelope. Anything else throws rather than being guessed at.
 */
export function parseModelIncidentOutput(raw: string): unknown[] {
  const text = raw.trim();
  if (!text) throw new Error("model command returned no output");

  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    const content = (parsed as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    if (typeof content === "string") return parseModelIncidentOutput(content);
  } catch {
    // Fall through to extraction below.
  }

  const extracted = firstJsonArray(text);
  if (extracted) {
    const parsed: unknown = JSON.parse(extracted);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error("model command did not return a JSON incident array");
}
