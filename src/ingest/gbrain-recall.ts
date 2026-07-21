import { existsSync } from "node:fs";

/**
 * Optional, off-by-default bridge that pushes a mined incident to a running
 * GBrain instance. Mirrors the `codebase-memory-semantic.ts` shape: external
 * process, TTL-cached probe, bounded output, untrusted-branded payload.
 *
 * VibeBloat must never hard-depend on GBrain being installed. The export path
 * only fires when `[semantic] gbrain_export = true` is set and the configured
 * executable is reachable; both checks fail closed.
 */

const maximumOutputBytes = 1_048_576;
const successfulProbeTtlMs = 60_000;
const failedProbeTtlMs = 10_000;
const defaultTimeoutMs = 5_000;
const defaultProbeTimeoutMs = 500;
const allowedCommands = new Set(["status", "incident"]);

/** Untrusted-branded payload. A GBrain reader can consume this verbatim. */
export interface GbrainIncidentPayload {
  incidentId: string;
  command: string;
  argsContains: readonly string[];
  condition: string;
  consequence: string;
  signature: string;
  recordedAt: string;
  source: "vibebloat-recall";
}

export interface GbrainProcessRequest {
  executable: string;
  args: string[];
  stdin?: string;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface GbrainProcessResult {
  exitCode: number;
  stdout: string;
}

export type GbrainExecutor = (request: GbrainProcessRequest) => Promise<GbrainProcessResult>;

export interface GbrainRecallExporterOptions {
  executable?: string;
  executor?: GbrainExecutor;
  env?: Record<string, string | undefined>;
  pathExists?: (path: string) => boolean;
  now?: () => number;
  timeoutMs?: number;
}

interface CachedAvailability {
  expiresAt: number;
  available: boolean;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function readBoundedOutput(
  stream: ReadableStream<Uint8Array>,
  onLimit: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumOutputBytes) {
        onLimit();
        throw new Error("backend-output-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export const executeGbrain: GbrainExecutor = async (request) => {
  if (request.signal.aborted) throw abortError();
  const child = Bun.spawn({
    cmd: [request.executable, ...request.args],
    stdin: request.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  if (request.stdin !== undefined) {
    child.stdin.write(request.stdin);
    child.stdin.end();
  }
  let timedOut = false;
  const kill = () => {
    try { child.kill(); } catch { return; }
  };
  request.signal.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(() => { timedOut = true; kill(); }, request.timeoutMs + 25);
  try {
    const stdoutPromise = readBoundedOutput(child.stdout, kill);
    const exitCode = await child.exited;
    const stdout = await stdoutPromise;
    if (request.signal.aborted) throw abortError();
    if (timedOut) throw new DOMException("Timed out", "TimeoutError");
    return { exitCode, stdout };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", kill);
  }
};

export function discoverGbrainExecutable(
  options: Pick<GbrainRecallExporterOptions, "env" | "pathExists"> = {},
): string {
  const env = options.env ?? process.env;
  const explicit = env.GBRAIN_MCP_PATH?.trim();
  if (explicit) return explicit;
  const pathExists = options.pathExists ?? existsSync;
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData) {
      const known = `${localAppData.replace(/[\\/]+$/, "")}\\Programs\\gbrain-mcp\\gbrain-mcp.exe`;
      if (pathExists(known)) return known;
    }
  }
  return process.platform === "win32" ? "gbrain-mcp.exe" : "gbrain-mcp";
}

export interface ExportedIncident {
  incidentId: string;
  command: string;
  argsContains?: readonly string[];
  condition: string;
  consequence: string;
  signature: string;
  canonicalCommand: string;
  recordedAt?: string;
}

export type ExportOutcome =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Pushes one recorded incident to GBrain. Off by default; callers gate on
 * `[semantic] gbrain_export = true` (see `recordIncidentForRecall`). The
 * exporter never throws and never blocks the proposal path.
 */
export class GbrainRecallExporter {
  readonly id = "gbrain-recall" as const;
  readonly #executable: string;
  readonly #executor: GbrainExecutor;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #availability = new Map<string, CachedAvailability>();

  constructor(options: GbrainRecallExporterOptions = {}) {
    this.#executable = options.executable ?? discoverGbrainExecutable(options);
    this.#executor = options.executor ?? executeGbrain;
    this.#now = options.now ?? Date.now;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  /**
   * Cached reachability probe. The cache key is the resolved executable path
   * because reinstalling GBrain at a new path should re-probe, not reuse a
   * stale verdict.
   */
  async probe(signal: AbortSignal): Promise<boolean> {
    const key = this.#executable;
    const cached = this.#availability.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.available;
    let available = false;
    try {
      await this.#invoke("status", [], undefined, Math.min(defaultProbeTimeoutMs, this.#timeoutMs), signal);
      available = true;
    } catch (error) {
      if (!signal.aborted) available = false;
      void error;
    }
    this.#availability.set(key, {
      expiresAt: this.#now() + (available ? successfulProbeTtlMs : failedProbeTtlMs),
      available,
    });
    return available;
  }

  async exportIncident(incident: ExportedIncident, signal?: AbortSignal): Promise<ExportOutcome> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const payload: GbrainIncidentPayload = {
        incidentId: incident.incidentId,
        command: incident.command,
        argsContains: [...(incident.argsContains ?? [])],
        condition: incident.condition,
        consequence: incident.consequence,
        signature: incident.signature,
        recordedAt: incident.recordedAt ?? new Date().toISOString(),
        source: "vibebloat-recall",
      };
      const result = await this.#invoke(
        "incident",
        ["--source", "vibebloat-recall"],
        JSON.stringify(payload),
        this.#timeoutMs,
        controller.signal,
      );
      return result.exitCode === 0 ? { ok: true } : { ok: false, reason: `exit-${result.exitCode}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : "executor-error";
      return { ok: false, reason: message };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async #invoke(
    command: string,
    args: string[],
    stdin: string | undefined,
    timeoutMs: number,
    parentSignal: AbortSignal,
  ): Promise<GbrainProcessResult> {
    if (!allowedCommands.has(command)) throw new Error("forbidden-backend-command");
    return this.#executor({
      executable: this.#executable,
      args: ["recall", command, ...args],
      ...(stdin !== undefined ? { stdin } : {}),
      signal: parentSignal,
      timeoutMs,
    });
  }
}

export function createGbrainRecallExporter(
  options: GbrainRecallExporterOptions = {},
): GbrainRecallExporter {
  return new GbrainRecallExporter(options);
}
