// Neural embedding sidecar. Runs under Node (never Bun): onnxruntime-node's
// native binding enumerates zero execution providers under Bun on Windows, so
// the vibebloat CLI (a Bun process) shells out to `node` for the real model.
// The transformers *node* build + default onnxruntime-node is the only combo
// that produces vectors here — forcing onnxruntime-web hands Bun an empty
// provider list and throws `Unsupported device: "cpu"`.
//
// Protocol: one JSON request on stdin, one JSON response on stdout.
//   in:  { "texts": string[], "model"?: string, "cacheDir"?: string }
//   out: { "ok": true, "dims": number, "vectors": number[][] }
//        { "ok": false, "error": string }
// Exit 0 on a well-formed response either way; exit 1 only on protocol failure.

import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(error) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error) }) + "\n");
  process.exit(0);
}

async function main() {
  let request;
  try {
    request = JSON.parse(await readStdin());
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: `bad request: ${error}` }) + "\n");
    process.exit(1);
  }

  const texts = Array.isArray(request?.texts) ? request.texts.filter((t) => typeof t === "string") : [];
  if (texts.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, dims: 0, vectors: [] }) + "\n");
    process.exit(0);
  }

  let transformers;
  try {
    transformers = await import("@huggingface/transformers");
  } catch (error) {
    fail(`transformers unavailable: ${error}`);
    return;
  }

  const { pipeline, env } = transformers;
  if (typeof request?.cacheDir === "string" && request.cacheDir) env.cacheDir = request.cacheDir;
  env.allowLocalModels = true;
  env.allowRemoteModels = true; // first run pulls the model; cached offline after

  const model = typeof request?.model === "string" && request.model ? request.model : DEFAULT_MODEL;

  let extractor;
  try {
    extractor = await pipeline("feature-extraction", model, { quantized: true });
  } catch (error) {
    fail(`model load failed: ${error}`);
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
    process.stdout.write(JSON.stringify({ ok: true, dims, vectors }) + "\n");
    await delay(0);
    process.exit(0);
  } catch (error) {
    fail(`embedding failed: ${error}`);
  }
}

main().catch(fail);
