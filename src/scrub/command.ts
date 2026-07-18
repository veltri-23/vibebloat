import type { Scrubber } from "./presidio";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandExecutor = (command: readonly string[], input: string) => Promise<CommandResult>;

interface ScrubResponse {
  payload: string;
  findings?: unknown[];
}

export async function executeCommand(command: readonly string[], input: string): Promise<CommandResult> {
  const process = Bun.spawn([...command], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  process.stdin.write(input);
  process.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

export function createCommandScrubber(
  tool: string,
  command: readonly string[],
  execute: CommandExecutor = executeCommand,
  requireNoFindings = false,
): Scrubber {
  return async (payload) => {
    const result = await execute(command, JSON.stringify({ payload }));
    if (result.exitCode !== 0) throw new Error(`${tool} failed`);

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(`${tool} returned invalid JSON`);
    }
    if (!isScrubResponse(parsed) || (requireNoFindings && parsed.findings?.length)) {
      throw new Error(`${tool} returned an unsafe result`);
    }
    return parsed.payload;
  };
}

function isScrubResponse(value: unknown): value is ScrubResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return typeof response.payload === "string" && (response.findings === undefined || Array.isArray(response.findings));
}
