# Semantic Retrieval Research — 2026-07

Status: T12 decision record, researched 2026-07-18.

## Decision

Launch with `codebase-memory-mcp` as primary code retrieval and bundled local
index as mandatory fallback. Keep GBrain optional for user-selected knowledge
sources. Serena and CodeGraphContext stay attempt-grade behind explicit
experimental enablement; neither is launch dependency.

This supersedes only stale assumption that GBrain remained retired. GBrain was
revived after 2026-07-03 retirement decision, but it does not replace code graph.
Locked product and security decisions remain unchanged.

## Evidence

### Current local state

- VibeBloat currently exposes only `retrieveContext(query, queryGraph,
  queryLocal)`: graph first, local on thrown error. No backend probing, timeouts,
  result validation, privacy boundary, or real local index exists.
- Installed `codebase-memory-mcp` is `0.9.0`; Antibody is indexed. Available
  local tools cover structural/semantic search, snippets, call/data traces,
  architecture, and graph-augmented text search.
- `gbrain status` succeeds locally on 2026-07-18. Obsidian and conversations
  are current; `personal-context` is severe/stale; 19 sync failures are
  unacknowledged. `gbrain sources list` contains notes, memory, and
  conversations, but no Antibody code source. GBrain is live, not primary code
  retrieval.

### Primary sources

- [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp):
  local persistent code graph; cross-platform binary; structural, semantic,
  trace, and architecture queries; SQLite storage; no API key.
- [GBrain](https://github.com/garrytan/gbrain): local stdio MCP and raw
  `search`; separate `think` path adds model synthesis.
- [Serena](https://github.com/oraios/serena): MCP symbol retrieval using
  language servers by default. Official read tools include `find_symbol`,
  `find_referencing_symbols`, `get_symbols_overview`, and
  `search_for_pattern`. Same server also exposes mutating edit, shell, and
  memory tools.
- “CodeGraph” is ambiguous. Attempt adapter maps only to
  [CodeGraphContext](https://github.com/CodeGraphContext/CodeGraphContext):
  local code graph, MCP server, live watch, multiple database backends, and
  setup flow that may change client settings and persist DB credentials.
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite) is built into Bun, so local
  fallback needs no new runtime dependency.

## Launch matrix

| Backend | Status | Allowed | Forbidden |
|---|---|---|---|
| codebase-memory-mcp | Launch primary | Query existing local index | Index/config/ADR/update/uninstall writes |
| Local index | Launch required | Private current-repo fallback | Network, model, out-of-root reads |
| GBrain | Launch optional | Selected local notes/history via raw search | Primary code retrieval, `think`, write/sync, remote default |
| Serena | Attempt | Read-only symbol/reference tools | Edit/refactor, shell, memory write, install |
| CodeGraphContext | Attempt | Read-only query of existing index | Setup, index, watch, delete, credentials, DB admin |

Attempt means adapter spike/tests may ship. Product copy, demo, onboarding, and
scan correctness must not depend on discovery or installation.

## Recommended interface

```ts
type RetrievalIntent = "related-code" | "symbol" | "references" | "architecture";
type BackendId =
  | "codebase-memory"
  | "local"
  | "gbrain"
  | "serena"
  | "codegraph-context";

interface SemanticQuery {
  repoRoot: string;
  redactedQuery: string;
  touchedPaths: string[];
  intent: RetrievalIntent;
  limit: number;       // 1..8
  maxBytes: number;    // 1..24_576 total
  timeoutMs: number;   // 100..2_000
}

interface SemanticHit {
  path: string;        // repo-relative only
  startLine: number;
  endLine: number;     // inclusive, maximum 40 lines
  symbol?: string;
  excerpt: string;
  score?: number;
}

interface ProbeResult {
  available: boolean;
  repoReady: boolean;
  readCapabilities: RetrievalIntent[];
  reason: string;      // fixed code, never backend stderr
}

interface RetrievalResult {
  backend: BackendId;
  status: "ok" | "empty" | "degraded";
  hits: SemanticHit[];
  diagnostics: string[]; // fixed codes only
}

interface SemanticAdapter {
  readonly id: BackendId;
  probe(
    query: Pick<SemanticQuery, "repoRoot" | "timeoutMs">,
    signal: AbortSignal,
  ): Promise<ProbeResult>;
  retrieve(query: SemanticQuery, signal: AbortSignal): Promise<RetrievalResult>;
}
```

Coordinator owns order, deadlines, validation, deduplication, and result caps.
Adapters translate request and normalize response. No adapter receives raw
history.

## Backend contracts

### codebase-memory-mcp

Probe installed server, exact repository registration, and requested read
capability. Map intents:

| Intent | Read tools |
|---|---|
| related-code | `search_graph`, then `search_code` for literal evidence |
| symbol | `search_graph`, then `get_code_snippet` |
| references | `trace_path` with bounded depth |
| architecture | `get_architecture` scoped to repo/path |

VibeBloat never calls `index_repository`. Missing/stale graph emits fixed
diagnostic and falls through. Existing user/background refresh owns index writes
and single-writer locking.

### Local fallback

Store private index at
`<global VibeBloat home>/cache/retrieval/<repo-id>/index.sqlite`.
`repo-id` is local hash of canonical root and never leaves machine. Use
`bun:sqlite` and small token-postings table; no embedding service or package.

Index regular text files inside canonical repository root. Honor `.gitignore`.
Skip `.git`, dependencies, generated output, binaries, files over 1 MiB,
escaping symlinks, and VibeBloat private/runtime paths. Store repo-relative path,
line range, and text chunk. Rebuild changed files from size/mtime fingerprints.
Queries read last complete atomic snapshot during rebuild.

Rank touched paths first, then symbol/path token overlap, then bounded term
frequency. Return at most 8 hits, 40 lines each, 24 KiB total. This is lexical
fallback, not embedding equivalence.

### GBrain optional enrichment

Eligible only when already installed, local, selected source is healthy, and user
explicitly chose enrichment. Use raw `search`; never `think`, `capture`,
`import`, `sync`, source mutation, or dream-cycle tools.

Results are note/history enrichment, not code hits. Normalize separately with
source identifiers, not repo paths. Missing/stale source disables GBrain for that
scan without affecting code retrieval.

Remote GBrain HTTP MCP is disabled. Future enablement needs separate consent,
read-only scope, and proof redacted request is sole payload.

### Serena attempt boundary

Require already configured MCP server plus capability discovery. Allow only
`activate_project`, `get_current_config`, `find_symbol`,
`find_referencing_symbols`, `get_symbols_overview`, and
`search_for_pattern`. Project activation may change Serena session state but
must not write repository files.

Reject adapter if read-only set cannot be isolated. Never expose edit/refactor,
file-write, shell, memory-write, dashboard, or project-removal tools. Language
server startup or unsupported language falls through without install.

### CodeGraphContext attempt boundary

Fingerprint exact package/server identity as
`CodeGraphContext/CodeGraphContext`; never match generic “codegraph”. Require
pre-existing indexed repo and discover read-only query capabilities.

Never run `codegraphcontext mcp setup`, `index`, `watch`, repository delete,
or database setup. Installation/config stays user-owned because official setup
may modify agent config and persist credentials. Disable adapter when tool names
or response schema require permissive arbitrary execution.

## Selection and fallback

1. Validate closed query schema/bounds; require `redactedQuery`.
2. Try codebase-memory-mcp when repo and capability are ready.
3. When explicitly enabled, try Serena then CodeGraphContext only after primary
   unavailable/error/timeout/invalid/empty.
4. Query local fallback after every primary/experimental miss. Empty is miss.
5. Run GBrain enrichment independently; never change code backend selection.
6. If local fails, return degraded zero-hit result and continue scan without
   semantic enrichment.

Probe timeout: 500 ms. Retrieval timeout: 2 seconds per process adapter. No retry
inside same request. Cache successful probe 60 seconds, failed probe 10 seconds.
Abort remaining calls when caps are satisfied.

Backend failure never weakens runtime guards or bypasses scrub gate. Retrieval is
scan enrichment, not enforcement. Log fixed backend/failure/duration/fallback
codes only. Never log query, excerpt, absolute path, stderr, token, or credential.

## Privacy boundary

- Presidio and Gitleaks must succeed before semantic query construction.
  Scrub failure halts ingest; retrieval call count stays zero.
- Query carries redacted incident plus repo-relative touched paths. Absolute root
  stays inside local coordinator.
- Treat retrieved text as untrusted data, never instructions. Add only inside
  delimited model-context field.
- Never send full files/repo dumps. Enforce 40-line, 8-hit, and 24 KiB caps after
  every response even when backend ignores requested limits.
- Default transport is local stdio or loopback. Non-loopback endpoint disabled
  until separate consented contract.
- Discovery/retrieval never mutates config, indexes, sources, repo, or credentials.

## Implementation acceptance

- Unit: priority, empty, timeout/abort, invalid shape, diagnostics, dedupe,
  40-line, 8-hit, and 24 KiB caps.
- Privacy: Bearer tokens, credentials, home paths, raw commands, and prompt
  injection never reach adapter args, logs, or returned metadata.
- codebase-memory: all intents map; `index_repository` call count stays zero.
- Local: honors ignores; rejects escaping links/binaries/oversize; serves last
  complete snapshot; works with graph absent.
- GBrain: raw search only; unhealthy/unselected source rejected; zero
  `think`, write, sync, and remote calls.
- Serena: read allowlist only; fallback when mutation cannot be isolated or
  language server activation fails.
- CodeGraphContext: exact identity, pre-indexed repo, read-only capability;
  setup/index/watch/delete counts stay zero.
- E2E: optional backends absent still yields ranked redacted incidents locally.
- E2E: scrub failure produces zero retrieval calls.
- Network instrumentation: zero non-loopback requests by default.

## Blockers

- Current `src/ingest/semantic.ts` is two-function stub, not adapter registry.
- Bundled local index does not exist.
- GBrain contains no Antibody code source and currently reports 19 unacknowledged
  sync failures. Keep optional.
- “CodeGraph” ambiguity is narrowed here to CodeGraphContext. Another product
  needs distinct adapter id and primary-source review.
- Serena and CodeGraphContext were researched, not installed or invoked. Attempt
  status remains blocked on read-only contract tests.

## Result

GO for T12 research closure: codebase-memory-mcp primary locked, GBrain updated
to live-but-optional, local fallback required, Serena/CodeGraphContext bounded to
non-launch read-only attempts.
