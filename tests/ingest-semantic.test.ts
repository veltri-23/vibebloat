import { expect, test } from "bun:test";
import {
  retrieveContext,
  retrieveSemanticContext,
  type SemanticAdapter,
  type SemanticBackendId,
  type SemanticHit,
  type SemanticQuery,
} from "../src/ingest/semantic";

const query: SemanticQuery = {
  repoRoot: "D:/repo",
  redactedQuery: "git stash",
  touchedPaths: ["src/git.ts"],
  intent: "related-code",
};

const hit = (path: string, excerpt = "result"): SemanticHit => ({
  path,
  startLine: 1,
  endLine: Math.max(1, excerpt.split("\n").length),
  excerpt,
});

function adapter(id: SemanticBackendId, hits: SemanticHit[], calls?: string[]): SemanticAdapter {
  return {
    id,
    async probe() {
      calls?.push(`${id}:probe`);
      return { available: true, repoReady: true, readCapabilities: ["related-code"], reason: "ready" };
    },
    async retrieve() {
      calls?.push(`${id}:retrieve`);
      return { hits };
    },
  };
}

test("legacy semantic helper keeps graph then local compatibility", async () => {
  expect(await retrieveContext("git stash", async () => ["graph result"], async () => ["local result"])).toEqual({ source: "codebase-memory", results: ["graph result"] });
  expect(await retrieveContext("git stash", async () => { throw new Error("offline"); }, async () => ["local result"])).toEqual({ source: "local", results: ["local result"] });
});

test("primary success stops selection before experimental and local adapters", async () => {
  const calls: string[] = [];
  const result = await retrieveSemanticContext(query, {
    primary: adapter("codebase-memory", [hit("src/primary.ts")], calls),
    experimental: [adapter("serena", [hit("src/experimental.ts")], calls)],
    enableExperimental: true,
    local: adapter("local", [hit("src/local.ts")], calls),
  });

  expect(result).toEqual({
    backend: "codebase-memory",
    status: "ok",
    hits: [hit("src/primary.ts")],
    diagnostics: [],
  });
  expect(calls).toEqual(["codebase-memory:probe", "codebase-memory:retrieve"]);
});

test("invalid query trust-boundary input returns a fixed diagnostic before any adapter call", async () => {
  const calls: string[] = [];
  const options = {
    primary: adapter("codebase-memory", [hit("src/primary.ts")], calls),
    local: adapter("local", [hit("src/local.ts")], calls),
  };
  const invalidQueries = [
    { ...query, repoRoot: "relative/repo" },
    { ...query, redactedQuery: "   " },
    { ...query, intent: "write-code" as SemanticQuery["intent"] },
    { ...query, touchedPaths: ["/absolute/private.ts"] },
    { ...query, touchedPaths: ["../escape.ts"] },
  ];

  for (const invalidQuery of invalidQueries) {
    expect(await retrieveSemanticContext(invalidQuery, options)).toEqual({
      backend: "local",
      status: "degraded",
      hits: [],
      diagnostics: ["coordinator:query-invalid"],
    });
  }
  expect(calls).toEqual([]);
});

test("empty primary falls directly to local when experimental adapters are disabled by default", async () => {
  const calls: string[] = [];
  const result = await retrieveSemanticContext(query, {
    primary: adapter("codebase-memory", [], calls),
    experimental: [adapter("serena", [hit("src/experimental.ts")], calls)],
    local: adapter("local", [hit("src/local.ts")], calls),
  });

  expect(result.backend).toBe("local");
  expect(result.hits).toEqual([hit("src/local.ts")]);
  expect(result.diagnostics).toEqual(["codebase-memory:backend-empty"]);
  expect(calls).toEqual(["codebase-memory:probe", "codebase-memory:retrieve", "local:probe", "local:retrieve"]);
});

test("enabled experimental adapters run in declared order before local fallback", async () => {
  const calls: string[] = [];
  const result = await retrieveSemanticContext(query, {
    primary: adapter("codebase-memory", [], calls),
    experimental: [
      adapter("serena", [], calls),
      adapter("codegraph-context", [hit("src/codegraph.ts")], calls),
    ],
    enableExperimental: true,
    local: adapter("local", [hit("src/local.ts")], calls),
  });

  expect(result.backend).toBe("codegraph-context");
  expect(result.diagnostics).toEqual([
    "codebase-memory:backend-empty",
    "serena:backend-empty",
  ]);
  expect(calls).toEqual([
    "codebase-memory:probe",
    "codebase-memory:retrieve",
    "serena:probe",
    "serena:retrieve",
    "codegraph-context:probe",
    "codegraph-context:retrieve",
  ]);
});

test("unavailable and invalid adapters emit fixed diagnostics then fall back", async () => {
  const primary: SemanticAdapter = {
    id: "codebase-memory",
    async probe() {
      return { available: false, repoReady: false, readCapabilities: [], reason: "not-indexed" };
    },
    async retrieve() {
      throw new Error("must not run");
    },
  };
  const invalid: SemanticAdapter = {
    id: "serena",
    async probe() {
      return { available: true, repoReady: true, readCapabilities: ["related-code"], reason: "ready" };
    },
    async retrieve() {
      return { hits: [{ path: "src/invalid.ts" }] };
    },
  };

  const result = await retrieveSemanticContext(query, {
    primary,
    experimental: [invalid],
    enableExperimental: true,
    local: adapter("local", [hit("src/local.ts")]),
  });

  expect(result.backend).toBe("local");
  expect(result.diagnostics).toEqual([
    "codebase-memory:backend-unavailable",
    "serena:backend-invalid",
  ]);
});

test("adapter errors emit fixed diagnostics and fall back without retry", async () => {
  let retrievalCalls = 0;
  const primary: SemanticAdapter = {
    id: "codebase-memory",
    async probe() {
      return { available: true, repoReady: true, readCapabilities: ["related-code"], reason: "ready" };
    },
    async retrieve() {
      retrievalCalls += 1;
      throw new Error("private backend detail");
    },
  };

  const result = await retrieveSemanticContext(query, {
    primary,
    local: adapter("local", [hit("src/local.ts")]),
  });

  expect(result.backend).toBe("local");
  expect(result.diagnostics).toEqual(["codebase-memory:backend-error"]);
  expect(retrievalCalls).toBe(1);
});

test("timeout aborts the adapter once and falls back without retry", async () => {
  let retrievalCalls = 0;
  let aborted = false;
  const primary: SemanticAdapter = {
    id: "codebase-memory",
    async probe() {
      return { available: true, repoReady: true, readCapabilities: ["related-code"], reason: "ready" };
    },
    retrieve(_query, signal) {
      retrievalCalls += 1;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  };

  const result = await retrieveSemanticContext({ ...query, timeoutMs: 10 }, {
    primary,
    local: adapter("local", [hit("src/local.ts")]),
  });

  expect(result.backend).toBe("local");
  expect(result.diagnostics).toEqual(["codebase-memory:backend-timeout"]);
  expect(retrievalCalls).toBe(1);
  expect(aborted).toBeTrue();
});

test("coordinator enforces hit, line, and UTF-8 byte caps", async () => {
  const fiftyLines = Array.from({ length: 50 }, () => "x").join("\n");
  const manyHits = Array.from({ length: 10 }, (_, index) => hit(`src/${index}.ts`, fiftyLines));
  const capped = await retrieveSemanticContext(query, {
    primary: adapter("codebase-memory", manyHits),
    local: adapter("local", []),
  });

  expect(capped.hits).toHaveLength(8);
  expect(capped.hits.every((candidate) => candidate.excerpt.split("\n").length <= 40)).toBeTrue();
  expect(capped.diagnostics).toEqual(["codebase-memory:results-truncated"]);

  const byteCapped = await retrieveSemanticContext(query, {
    primary: adapter("codebase-memory", [hit("src/large.ts", "😀".repeat(10_000))]),
    local: adapter("local", []),
  });
  const serializedBytes = Buffer.byteLength(JSON.stringify(byteCapped.hits));
  expect(serializedBytes).toBeLessThanOrEqual(24_576);
  expect(byteCapped.diagnostics).toEqual(["codebase-memory:results-truncated"]);
});

test("a byte cap too small for the first code point falls back instead of returning empty success", async () => {
  const result = await retrieveSemanticContext({ ...query, maxBytes: 1 }, {
    primary: adapter("codebase-memory", [hit("src/emoji.ts", "😀")]),
    local: adapter("local", [hit("src/local.ts", "x")]),
  });

  expect(result.backend).toBe("local");
  expect(result.status).toBe("empty");
  expect(result.hits).toEqual([]);
  expect(result.diagnostics).toEqual([
    "codebase-memory:results-truncated",
    "codebase-memory:backend-empty",
    "local:results-truncated",
    "local:backend-empty",
  ]);
});

test("metadata and excerpts share the same 24 KiB budget", async () => {
  const metadataHeavy = hit(`src/${"nested/".repeat(4_000)}file.ts`, "small");
  const result = await retrieveSemanticContext(query, {
    primary: adapter("codebase-memory", [metadataHeavy]),
    local: adapter("local", [hit("src/local.ts")]),
  });

  expect(result.backend).toBe("local");
  expect(Buffer.byteLength(JSON.stringify(result.hits))).toBeLessThanOrEqual(24_576);
  expect(result.diagnostics).toEqual([
    "codebase-memory:results-truncated",
    "codebase-memory:backend-empty",
  ]);
});
