import { expect, test } from "bun:test";
import {
  CodebaseMemorySemanticAdapter,
  discoverCodebaseMemoryExecutable,
  executeCodebaseMemory,
  type CodebaseMemoryExecutor,
  type CodebaseMemoryProcessRequest,
} from "../src/ingest/codebase-memory-semantic";
import { retrieveSemanticContext, type SemanticAdapter, type SemanticQuery } from "../src/ingest/semantic";

const repoRoot = "D:\\AI\\projects\\antibody";
const projectName = "D-AI-projects-antibody";

function query(intent: Required<SemanticQuery>["intent"], touchedPaths: string[] = ["src/ingest/semantic.ts"]): Required<SemanticQuery> {
  return {
    repoRoot,
    redactedQuery: "SemanticAdapter",
    touchedPaths,
    intent,
    limit: 4,
    maxBytes: 24_576,
    timeoutMs: 1_250,
  };
}

function tool(request: CodebaseMemoryProcessRequest): string {
  expect(request.args[0]).toBe("cli");
  return request.args[1]!;
}

function json(value: unknown) {
  return { exitCode: 0, stdout: JSON.stringify(value) };
}

function projects(root = "D:/AI/projects/antibody", nodes = 100) {
  return json({ projects: [{ name: projectName, root_path: root, nodes }] });
}

function scripted(
  responses: Record<string, unknown | ((request: CodebaseMemoryProcessRequest) => unknown)>,
  calls: CodebaseMemoryProcessRequest[] = [],
): CodebaseMemoryExecutor {
  return async (request) => {
    calls.push(request);
    const response = responses[tool(request)];
    if (response === undefined) throw new Error(`unexpected ${tool(request)}`);
    return json(typeof response === "function" ? response(request) : response);
  };
}

function adapter(executor: CodebaseMemoryExecutor) {
  return new CodebaseMemorySemanticAdapter({ executable: "mock-codebase-memory", executor });
}

test("executable discovery honors explicit override then known install then PATH", () => {
  expect(discoverCodebaseMemoryExecutable({
    env: { CODEBASE_MEMORY_MCP_PATH: " C:\\tools\\cbm.exe " },
    pathExists: () => false,
  })).toBe("C:\\tools\\cbm.exe");

  const discovered = discoverCodebaseMemoryExecutable({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    pathExists: (path) => path.endsWith("codebase-memory-mcp.exe"),
  });
  if (process.platform === "win32") {
    expect(discovered).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\codebase-memory-mcp\\codebase-memory-mcp.exe");
  } else {
    expect(discovered).toBe("codebase-memory-mcp");
  }
});

test("probe requires exact registered root and a nonempty graph", async () => {
  const calls: CodebaseMemoryProcessRequest[] = [];
  const primary = adapter(scripted({ list_projects: projects().stdout && JSON.parse(projects().stdout) }, calls));
  const signal = new AbortController().signal;

  expect(await primary.probe({ repoRoot, timeoutMs: 500 }, signal)).toEqual({
    available: true,
    repoReady: true,
    readCapabilities: ["related-code", "symbol", "references", "architecture"],
    reason: "ready",
  });
  expect(await primary.probe({ repoRoot, timeoutMs: 500 }, signal)).toEqual(expect.objectContaining({ reason: "ready" }));
  expect(calls).toHaveLength(1);
  expect(tool(calls[0]!)).toBe("list_projects");

  const wrongRoot = adapter(scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/other", nodes: 10 }] },
  }));
  expect(await wrongRoot.probe({ repoRoot, timeoutMs: 500 }, signal)).toEqual({
    available: true,
    repoReady: false,
    readCapabilities: ["related-code", "symbol", "references", "architecture"],
    reason: "repo-not-registered",
  });

  const empty = adapter(scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 0 }] },
  }));
  expect((await empty.probe({ repoRoot, timeoutMs: 500 }, signal)).reason).toBe("repo-empty");
});

test("related-code uses graph and literal read tools with argv, fixed paths, and no shell", async () => {
  const calls: CodebaseMemoryProcessRequest[] = [];
  const primary = adapter(scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 100 }] },
    search_graph: {
      results: [{
        name: "SemanticAdapter",
        qualified_name: `${projectName}.src.ingest.semantic.SemanticAdapter`,
        file_path: "src/ingest/semantic.ts",
        signature: " interface",
      }],
    },
    search_code: {
      results: [{
        node: "SemanticAdapter",
        file: "src/ingest/semantic.ts",
        start_line: 38,
        end_line: 42,
        context_start: 36,
        context: `from ${repoRoot}\\src\\ingest\\semantic.ts\nexport interface SemanticAdapter {}`,
      }],
    },
  }, calls));

  const result = await primary.retrieve(query("related-code"), new AbortController().signal);

  expect(calls.map(tool)).toEqual(["list_projects", "search_graph", "search_code"]);
  expect(calls.every((call) => call.executable === "mock-codebase-memory" && call.stdin === undefined)).toBeTrue();
  expect(calls[1]!.args).toContain("SemanticAdapter");
  expect(result.hits[0]).toEqual(expect.objectContaining({ path: "src/ingest/semantic.ts", startLine: 36 }));
  expect(JSON.stringify(result)).not.toContain(repoRoot);
});

test("symbol uses graph discovery then snippet and normalizes in-root absolute paths", async () => {
  const calls: CodebaseMemoryProcessRequest[] = [];
  const primary = adapter(scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 100 }] },
    search_graph: {
      results: [{
        name: "SemanticAdapter",
        qualified_name: `${projectName}.src.ingest.semantic.SemanticAdapter`,
        file_path: "src/ingest/semantic.ts",
      }],
    },
    get_code_snippet: {
      name: "SemanticAdapter",
      file_path: "D:/AI/projects/antibody/src/ingest/semantic.ts",
      start_line: 38,
      end_line: 42,
      source: "export interface SemanticAdapter {}",
    },
  }, calls));

  const result = await primary.retrieve(query("symbol"), new AbortController().signal);

  expect(calls.map(tool)).toEqual(["list_projects", "search_graph", "get_code_snippet"]);
  expect(result.hits).toEqual([{
    path: "src/ingest/semantic.ts",
    startLine: 38,
    endLine: 42,
    symbol: "SemanticAdapter",
    excerpt: "export interface SemanticAdapter {}",
  }]);
});

test("references invokes only bounded trace_path after registration", async () => {
  const calls: CodebaseMemoryProcessRequest[] = [];
  const primary = adapter(scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 100 }] },
    trace_path: {
      function: "SemanticAdapter",
      callers: [{ name: "retrieveSemanticContext", qualified_name: `${projectName}.src.ingest.semantic.retrieveSemanticContext`, hop: 1 }],
      callees: [],
    },
  }, calls));

  const result = await primary.retrieve(query("references"), new AbortController().signal);

  expect(calls.map(tool)).toEqual(["list_projects", "trace_path"]);
  expect(calls[1]!.args).toEqual([
    "cli", "trace_path", "--project", projectName,
    "--function-name", "SemanticAdapter", "--direction", "both",
    "--depth", "2", "--mode", "calls", "--include-tests", "false",
  ]);
  expect(result.hits[0]).toEqual(expect.objectContaining({ path: "src/ingest/semantic.ts", startLine: 1 }));
});

test("architecture scopes to touched directory and emits stable summary", async () => {
  const calls: CodebaseMemoryProcessRequest[] = [];
  const primary = adapter(scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 100 }] },
    get_architecture: {
      project: projectName,
      path: "src/ingest",
      total_nodes: 75,
      total_edges: 154,
      packages: [{ name: "ingest", node_count: 37 }],
      root_path: "C:/Users/private/repo",
    },
  }, calls));

  const result = await primary.retrieve(query("architecture"), new AbortController().signal);

  expect(calls.map(tool)).toEqual(["list_projects", "get_architecture"]);
  expect(calls[1]!.args).toContain("src/ingest");
  expect(result).toEqual({ hits: [{
    path: "src/ingest",
    startLine: 1,
    endLine: 1,
    excerpt: "Nodes: 75. Edges: 154. Packages: ingest (37).",
  }] });
  expect(JSON.stringify(result)).not.toContain("C:/Users/private");
});

test("invalid and out-of-root backend results are rejected without partial hits", async () => {
  for (const badPath of ["../outside.ts", "C:/Users/private/secret.ts", "/home/private/secret.ts"]) {
    const primary = adapter(scripted({
      list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 100 }] },
      search_graph: {
        results: [
          { name: "safe", file_path: "src/safe.ts" },
          { name: "secret", file_path: badPath },
        ],
      },
      search_code: { results: [] },
    }));

    expect(await primary.retrieve(query("related-code"), new AbortController().signal)).toEqual({ hits: [] });
  }
});

test("backend command failure falls through coordinator with fixed diagnostics only", async () => {
  const primary = adapter(async (request) => {
    if (tool(request) === "list_projects") {
      return projects();
    }
    return { exitCode: 1, stdout: "C:/Users/private/raw failure" };
  });
  const local: SemanticAdapter = {
    id: "local",
    async probe() {
      return { available: true, repoReady: true, readCapabilities: ["related-code"], reason: "ready" };
    },
    async retrieve() {
      return { hits: [{ path: "src/local.ts", startLine: 1, endLine: 1, excerpt: "fallback" }] };
    },
  };

  const result = await retrieveSemanticContext(query("related-code"), { primary, local });

  expect(result.backend).toBe("local");
  expect(result.diagnostics).toEqual(["codebase-memory:backend-error"]);
  expect(JSON.stringify(result)).not.toContain("Users/private");
});

test("adapter forwards AbortSignal and timeout without retry", async () => {
  const controller = new AbortController();
  const calls: CodebaseMemoryProcessRequest[] = [];
  const primary = adapter(async (request) => {
    calls.push(request);
    expect(request.signal).toBe(controller.signal);
    expect(request.timeoutMs).toBe(1_250);
    if (tool(request) === "list_projects") return projects();
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });

  await expect(primary.retrieve(query("related-code"), controller.signal)).rejects.toThrow();
  expect(calls.map(tool)).toEqual(["list_projects", "search_graph"]);
});

test("default executor kills a subprocess at its direct-call timeout", async () => {
  const startedAt = performance.now();
  await expect(executeCodebaseMemory({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 10000)"],
    signal: new AbortController().signal,
    timeoutMs: 10,
  })).rejects.toThrow("Timed out");
  expect(performance.now() - startedAt).toBeLessThan(2_000);
});

test("all subprocess tool names stay on explicit read allowlist", async () => {
  const calls: CodebaseMemoryProcessRequest[] = [];
  const executor = scripted({
    list_projects: { projects: [{ name: projectName, root_path: "D:/AI/projects/antibody", nodes: 100 }] },
    search_graph: { results: [] },
    search_code: { results: [] },
    trace_path: { callers: [], callees: [] },
    get_architecture: { project: projectName, total_nodes: 1, total_edges: 0, packages: [] },
  }, calls);
  for (const intent of ["related-code", "references", "architecture"] as const) {
    await adapter(executor).retrieve(query(intent), new AbortController().signal);
  }

  const allowed = new Set(["list_projects", "search_graph", "search_code", "trace_path", "get_architecture"]);
  expect(calls.every((call) => allowed.has(tool(call)))).toBeTrue();
  expect(calls.map(tool)).not.toContain("index_repository");
  expect(calls.map(tool)).not.toContain("configure_repository");
});
