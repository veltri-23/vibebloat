import { expect, test } from "bun:test";
import {
  type GbrainExecutor,
  type GbrainProcessRequest,
  type GbrainProcessResult,
  GbrainRecallExporter,
  createGbrainRecallExporter,
  discoverGbrainExecutable,
} from "../src/ingest/gbrain-recall";

/**
 * Adapter unit tests for the optional GBrain export bridge. Mirrors the
 * codebase-memory-semantic.ts test shape so the off-by-default, external-
 * process, TTL-cached contract is locked-in the same way.
 */

function jsonResult(value: unknown): GbrainProcessResult {
  return { exitCode: 0, stdout: typeof value === "string" ? value : JSON.stringify(value) };
}

function scripted(
  responses: Record<string, (request: GbrainProcessRequest) => GbrainProcessResult | undefined>,
  calls: GbrainProcessRequest[] = [],
): GbrainExecutor {
  return async (request) => {
    calls.push(request);
    const key = `${request.args[0] ?? ""}/${request.args[1] ?? ""}`;
    const responder = responses[key];
    if (!responder) throw new Error(`unexpected ${JSON.stringify(request.args)}`);
    const produced = responder(request);
    return produced ?? jsonResult({});
  };
}

test("executable discovery honors explicit override then known install then PATH name", () => {
  expect(discoverGbrainExecutable({
    env: { GBRAIN_MCP_PATH: " C:\\tools\\gbrain.exe " },
    pathExists: () => false,
  })).toBe("C:\\tools\\gbrain.exe");

  const discovered = discoverGbrainExecutable({
    env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    pathExists: (path) => path.endsWith("gbrain-mcp.exe"),
  });
  if (process.platform === "win32") {
    expect(discovered).toBe("C:\\Users\\tester\\AppData\\Local\\Programs\\gbrain-mcp\\gbrain-mcp.exe");
  } else {
    expect(discovered).toBe("gbrain-mcp");
  }
});

test("probe caches success for the successful TTL and failure for the shorter TTL", async () => {
  const calls: GbrainProcessRequest[] = [];
  const exporter = new GbrainRecallExporter({
    executable: "mock-gbrain-success",
    executor: scripted({ "recall/status": () => jsonResult({}) }, calls),
  });

  const signal = new AbortController().signal;
  expect(await exporter.probe(signal)).toBe(true);
  expect(await exporter.probe(signal)).toBe(true);
  expect(calls).toHaveLength(1);

  const failing = new GbrainRecallExporter({
    executable: "mock-gbrain-failure",
    executor: scripted({ "recall/status": () => { throw new Error("spawn failed"); } }, []),
  });
  expect(await failing.probe(signal)).toBe(false);
  expect(await failing.probe(signal)).toBe(false);
});

test("exportIncident pipes a stable, untrusted-branded payload and reports non-zero exits as failures", async () => {
  const calls: GbrainProcessRequest[] = [];
  const exporter = new GbrainRecallExporter({
    executable: "mock-gbrain",
    executor: scripted({
      "recall/status": () => jsonResult({}),
      "recall/incident": (request) => {
        const body = request.stdin ? JSON.parse(request.stdin) : null;
        expect(body).toMatchObject({
          incidentId: "live-git-stash-untracked",
          command: "git stash",
          condition: "untracked operational files left the live tree",
          consequence: "restore from the last good ref",
          source: "vibebloat-recall",
        });
        expect(body.signature).toBeString();
        expect(body.recordedAt).toBeString();
        expect(body.argsContains).toBeArray();
        return jsonResult({});
      },
    }, calls),
  });

  expect(await exporter.probe(new AbortController().signal)).toBe(true);
  const outcome = await exporter.exportIncident({
    incidentId: "live-git-stash-untracked",
    command: "git stash",
    argsContains: ["-u"],
    condition: "untracked operational files left the live tree",
    consequence: "restore from the last good ref",
    signature: "live-git-stash-untracked",
    canonicalCommand: "git stash -u",
  });
  expect(outcome).toEqual({ ok: true });
  expect(calls.find((c) => c.args[1] === "incident")?.args).toContain("--source");
  expect(calls.find((c) => c.args[1] === "incident")?.args).toContain("vibebloat-recall");

  const failing = new GbrainRecallExporter({
    executable: "mock-gbrain",
    executor: scripted({
      "recall/status": () => jsonResult({}),
      "recall/incident": () => ({ exitCode: 1, stdout: "" }),
    }, []),
  });
  expect(await failing.probe(new AbortController().signal)).toBe(true);
  const failed = await failing.exportIncident({
    incidentId: "x",
    command: "x",
    condition: "x",
    consequence: "x",
    signature: "x",
    canonicalCommand: "x",
  });
  expect(failed.ok).toBe(false);
  if (!failed.ok) expect(failed.reason).toBe("exit-1");
});

test("createGbrainRecallExporter returns a configured exporter", () => {
  expect(createGbrainRecallExporter()).toBeInstanceOf(GbrainRecallExporter);
});
