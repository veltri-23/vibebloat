// Neural embedding sidecar. Runs under Node (never Bun): onnxruntime-node's
// native binding enumerates zero execution providers under Bun on Windows.
//
// Protocol: one JSON request on stdin, one JSON response on stdout.
//   in:  { "texts": string[] }
//   out: { "ok": true, "dims": number, "vectors": number[][] }
//        { "ok": false, "error": { "code": string, "message": string } }
// Model and cache are control-plane CLI arguments, never request fields. The
// parent uses spawnSync with shell disabled, so embedded command text cannot
// become a model id, filesystem path, or process argument.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";
const SUPPORTED_MODELS = new Set([DEFAULT_MODEL]);
const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_TEXT_COUNT = 64;
const MAX_TEXT_BYTES = 16 * 1024;
const MAX_TOTAL_TEXT_BYTES = 256 * 1024;

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function writeResponse(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function fail(code, message, exitCode = 0) {
  writeResponse({ ok: false, error: { code, message: String(message).slice(0, 512) } });
  process.exitCode = exitCode;
}

async function readStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) {
      throw new ProtocolError("request_too_large", `request exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseControlArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--model" && flag !== "--cache-dir") || value === undefined || values.has(flag)) {
      throw new ProtocolError("invalid_arguments", "expected one --model and one --cache-dir argument");
    }
    values.set(flag, value);
  }
  if (values.size !== 2) {
    throw new ProtocolError("invalid_arguments", "expected one --model and one --cache-dir argument");
  }

  const model = values.get("--model");
  if (!SUPPORTED_MODELS.has(model)) {
    throw new ProtocolError("unsupported_model", "model is not supported");
  }

  const rawCacheDir = values.get("--cache-dir");
  if (!isAbsolute(rawCacheDir) || rawCacheDir.includes("\0") || rawCacheDir.length > 4096) {
    throw new ProtocolError("unsafe_cache_path", "cache directory must be an absolute dedicated path");
  }
  const cacheDir = resolve(rawCacheDir);
  const base = process.env.VIBEBLOAT_HOME
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? process.cwd();
  const allowedCacheDirs = [
    { path: resolve(base, "cache", "transformers"), root: resolve(base) },
    { path: resolve(process.cwd(), ".vibebloat-model-cache"), root: resolve(process.cwd()) },
  ];
  const pathKey = (path) => process.platform === "win32" ? path.toLowerCase() : path;
  const allowed = allowedCacheDirs.find((candidate) => pathKey(candidate.path) === pathKey(cacheDir));
  if (!allowed) {
    throw new ProtocolError("unsafe_cache_path", "cache directory is outside dedicated cache locations");
  }

  // Existing symlink/junction ancestors must still resolve beneath the trusted
  // base. This closes the obvious escape where the dedicated cache leaf points
  // elsewhere before transformers creates model files.
  let existingAncestor = cacheDir;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realRoot = realpathSync(allowed.root);
  const realAncestor = realpathSync(existingAncestor);
  const escaped = relative(realRoot, realAncestor);
  if (escaped === ".." || escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(escaped)) {
    throw new ProtocolError("unsafe_cache_path", "cache directory resolves outside its dedicated location");
  }

  return { model, cacheDir };
}

function parseRequest(raw) {
  let request;
  try {
    request = JSON.parse(raw);
  } catch {
    throw new ProtocolError("invalid_json", "stdin must contain one JSON object");
  }
  if (request === null || Array.isArray(request) || typeof request !== "object") {
    throw new ProtocolError("invalid_request", "request must be an object");
  }
  const keys = Object.keys(request);
  if (keys.length !== 1 || keys[0] !== "texts" || !Array.isArray(request.texts)) {
    throw new ProtocolError("invalid_request", "request must contain only a texts array");
  }
  if (request.texts.length > MAX_TEXT_COUNT) {
    throw new ProtocolError("too_many_texts", `texts exceeds ${MAX_TEXT_COUNT} items`);
  }

  let totalBytes = 0;
  for (const text of request.texts) {
    if (typeof text !== "string" || text.length === 0) {
      throw new ProtocolError("invalid_request", "each text must be a non-empty string");
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > MAX_TEXT_BYTES) {
      throw new ProtocolError("text_too_large", `one text exceeds ${MAX_TEXT_BYTES} bytes`);
    }
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_TEXT_BYTES) {
      throw new ProtocolError("texts_too_large", `texts exceed ${MAX_TOTAL_TEXT_BYTES} bytes total`);
    }
  }
  return request.texts;
}

async function main() {
  let control;
  let texts;
  try {
    control = parseControlArgs(process.argv.slice(2));
    texts = parseRequest(await readStdin());
  } catch (error) {
    if (error instanceof ProtocolError) fail(error.code, error.message, 1);
    else fail("invalid_request", "request validation failed", 1);
    return;
  }

  if (texts.length === 0) {
    writeResponse({ ok: true, dims: 0, vectors: [] });
    return;
  }

  let transformers;
  try {
    transformers = await import("@huggingface/transformers");
  } catch (error) {
    fail("transformers_unavailable", `transformers unavailable: ${error}`);
    return;
  }

  const { pipeline, env } = transformers;
  env.cacheDir = control.cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // first run pulls the allowlisted model only

  let extractor;
  try {
    extractor = await pipeline("feature-extraction", control.model, { quantized: true });
  } catch (error) {
    fail("model_load_failed", `model load failed: ${error}`);
    return;
  }

  try {
    const vectors = [];
    let dims = 0;
    for (const text of texts) {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      const data = Array.from(output.data);
      dims = data.length;
      vectors.push(data);
    }
    writeResponse({ ok: true, dims, vectors });
  } catch (error) {
    fail("embedding_failed", `embedding failed: ${error}`);
  }
}

main().catch((error) => fail("internal_error", `worker failed: ${error}`));
