import { describe, expect, test } from "bun:test";
import { dirname, join, parse } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerPath = fileURLToPath(new URL("../src/ingest/embed-worker.mjs", import.meta.url));
const model = "Xenova/all-MiniLM-L6-v2";
const cacheDir = join(process.cwd(), ".vibebloat-model-cache");

interface WorkerFailure {
  ok: false;
  error: { code: string; message: string };
}

function runWorker(input: string, args: string[] = ["--model", model, "--cache-dir", cacheDir]) {
  return spawnSync(process.env.VIBEBLOAT_NODE?.trim() || "node", [workerPath, ...args], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    shell: false,
  });
}

function failure(input: string, args?: string[]): WorkerFailure {
  const result = runWorker(input, args);
  expect(result.stdout).not.toBe("");
  const response = JSON.parse(result.stdout.trim()) as WorkerFailure;
  expect(response.ok).toBe(false);
  expect(typeof response.error?.code).toBe("string");
  expect(typeof response.error?.message).toBe("string");
  return response;
}

describe("embed worker trust boundary", () => {
  test("accepts an empty validated request without importing or downloading a model", () => {
    const result = runWorker(JSON.stringify({ texts: [] }));
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, dims: 0, vectors: [] });
  });

  test("returns structured protocol failures for malformed JSON and schema violations", () => {
    expect(failure("not json").error.code).toBe("invalid_json");
    expect(failure(JSON.stringify({ texts: ["ok", 7] })).error.code).toBe("invalid_request");
    expect(failure(JSON.stringify({ texts: [], model, cacheDir })).error.code).toBe("invalid_request");
  });

  test("enforces text count and UTF-8 byte limits before model import", () => {
    expect(failure(JSON.stringify({ texts: Array.from({ length: 65 }, () => "x") })).error.code).toBe("too_many_texts");
    expect(failure(JSON.stringify({ texts: ["x".repeat(16 * 1024 + 1)] })).error.code).toBe("text_too_large");
    expect(failure(JSON.stringify({ texts: Array.from({ length: 17 }, () => "x".repeat(16 * 1024)) })).error.code).toBe("texts_too_large");
    expect(failure(JSON.stringify({ texts: ["x".repeat(512 * 1024)] })).error.code).toBe("request_too_large");
  });

  test("rejects unsupported models even when command text contains an allowed model", () => {
    const text = `--model ${model} --cache-dir ${cacheDir}`;
    const response = failure(
      JSON.stringify({ texts: [text] }),
      ["--model", "attacker/arbitrary-model", "--cache-dir", cacheDir],
    );
    expect(response.error.code).toBe("unsupported_model");
  });

  test("rejects cache paths outside dedicated cache locations", () => {
    const unsafePath = parse(dirname(process.cwd())).root;
    const response = failure(
      JSON.stringify({ texts: [`--cache-dir ${cacheDir}`] }),
      ["--model", model, "--cache-dir", unsafePath],
    );
    expect(response.error.code).toBe("unsafe_cache_path");
    expect(failure(JSON.stringify({ texts: [] }), ["--model", model, "--cache-dir", ".vibebloat-model-cache"]).error.code).toBe("unsafe_cache_path");
  });
});
