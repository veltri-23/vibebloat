import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { LocalSemanticAdapter, localSemanticIndexPath } from "../src/ingest/local-semantic";
import type { SemanticQuery } from "../src/ingest/semantic";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; home: string } {
  const parent = mkdtempSync(join(tmpdir(), "vibebloat-local-semantic-"));
  roots.push(parent);
  const root = join(parent, "repo");
  const home = join(parent, "home");
  mkdirSync(root);
  Bun.spawnSync({ cmd: ["git", "init", "-q", root] });
  return { root, home };
}

function query(root: string, overrides: Partial<Required<SemanticQuery>> = {}): Required<SemanticQuery> {
  return {
    repoRoot: root,
    redactedQuery: "remove workspace cache",
    touchedPaths: [],
    intent: "related-code",
    limit: 8,
    maxBytes: 24_576,
    timeoutMs: 2_000,
    ...overrides,
  };
}

async function retrieve(adapter: LocalSemanticAdapter, value: Required<SemanticQuery>) {
  return adapter.retrieve(value, new AbortController().signal);
}

test("local index honors git ignores and skips private, dependency, generated, binary, and oversize files", async () => {
  const { root, home } = fixture();
  writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(root, "kept.ts"), "export function removeWorkspaceCache() { return true; } // remove workspace cache\n");
  writeFileSync(join(root, "ignored.ts"), "remove workspace cache ignored\n");
  for (const directory of [".vibebloat", "node_modules", "dist"]) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, "secret.ts"), "remove workspace cache private\n");
  }
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(root, "oversize.txt"), Buffer.alloc(1_048_577, 97));

  const result = await retrieve(new LocalSemanticAdapter({ home }), query(root));

  expect(result.hits.map((hit) => hit.path)).toEqual(["kept.ts"]);
  expect(result.hits[0]?.excerpt).not.toContain("ignored");
  const indexPath = localSemanticIndexPath(root, home);
  expect(dirname(indexPath)).not.toContain(basename(root));
  expect(basename(dirname(indexPath))).toMatch(/^[a-f0-9]{64}$/);
});

test("local index rejects symlinks including links escaping repository root", async () => {
  const { root, home } = fixture();
  const outside = join(root, "..", "outside.ts");
  writeFileSync(outside, "remove workspace cache outside\n");
  writeFileSync(join(root, "inside.ts"), "remove workspace cache inside\n");
  symlinkSync(outside, join(root, "escape.ts"), "file");

  const result = await retrieve(new LocalSemanticAdapter({ home }), query(root));

  expect(result.hits.map((hit) => hit.path)).toEqual(["inside.ts"]);
});

test("local index ranks exact touched path before stronger term frequency", async () => {
  const { root, home } = fixture();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "touched.ts"), "export const unrelated = true;\n");
  writeFileSync(join(root, "src", "frequent.ts"), "remove workspace cache remove workspace cache remove workspace cache\n");

  const result = await retrieve(new LocalSemanticAdapter({ home }), query(root, {
    redactedQuery: "remove workspace cache",
    touchedPaths: ["src/touched.ts"],
  }));

  expect(result.hits[0]?.path).toBe("src/touched.ts");
  expect(result.hits[1]?.path).toBe("src/frequent.ts");
});

test("local index boosts path and declared-symbol token overlap above bounded prose frequency", async () => {
  const { root, home } = fixture();
  writeFileSync(join(root, "symbols.ts"), "export function removeWorkspaceCache() { return true; }\n");
  writeFileSync(join(root, "prose.txt"), "remove workspace cache ".repeat(20));

  const result = await retrieve(new LocalSemanticAdapter({ home }), query(root));

  expect(result.hits[0]?.path).toBe("symbols.ts");
  expect(result.hits[0]?.symbol).toBe("removeWorkspaceCache");
});

test("incremental rebuild keeps unchanged rows and refreshes size-mtime changes", async () => {
  const { root, home } = fixture();
  const source = join(root, "source.ts");
  writeFileSync(source, "obsolete semantic token\n");
  const adapter = new LocalSemanticAdapter({ home });
  expect((await retrieve(adapter, query(root, { redactedQuery: "obsolete" }))).hits).toHaveLength(1);

  writeFileSync(source, "new semantic replacement token\n");
  const future = new Date(Date.now() + 2_000);
  utimesSync(source, future, future);
  expect((await retrieve(adapter, query(root, { redactedQuery: "obsolete" }))).hits).toHaveLength(0);
  expect((await retrieve(adapter, query(root, { redactedQuery: "replacement token" }))).hits[0]?.path).toBe("source.ts");
});

test("incremental rebuild does not reread unchanged size-mtime fingerprints", async () => {
  const { root, home } = fixture();
  writeFileSync(join(root, "source.ts"), "stable fingerprint token\n");
  let readCount = 0;
  const adapter = new LocalSemanticAdapter({
    home,
    readFile(path, options) {
      readCount += 1;
      return readFileSync(path, options as never);
    },
  });

  await retrieve(adapter, query(root, { redactedQuery: "fingerprint" }));
  await retrieve(adapter, query(root, { redactedQuery: "fingerprint" }));

  expect(readCount).toBe(1);
});

test("failed rebuild rolls back and concurrent reader sees last committed snapshot", async () => {
  const { root, home } = fixture();
  const stable = join(root, "stable.ts");
  writeFileSync(stable, "last committed snapshot marker\n");
  const initial = new LocalSemanticAdapter({ home });
  await retrieve(initial, query(root, { redactedQuery: "committed snapshot" }));

  writeFileSync(stable, "uncommitted replacement marker\n");
  const future = new Date(Date.now() + 2_000);
  utimesSync(stable, future, future);
  writeFileSync(join(root, "later.ts"), "trigger rollback marker\n");
  let observedDuringRebuild = "";
  let reads = 0;
  const failing = new LocalSemanticAdapter({
    home,
    readFile(path, options) {
      reads += 1;
      if (reads === 2) {
        const reader = new Database(localSemanticIndexPath(root, home), { readonly: true });
        const statement = reader.prepare("SELECT excerpt FROM chunks WHERE path = 'stable.ts'");
        observedDuringRebuild = (statement.get() as { excerpt: string }).excerpt;
        statement.finalize();
        reader.close(true);
        throw new Error("injected rebuild failure");
      }
      return readFileSync(path, options as never);
    },
  });

  expect(() => failing.rebuild(root)).toThrow("injected rebuild failure");
  expect(observedDuringRebuild).toContain("last committed snapshot");
  const reader = new Database(localSemanticIndexPath(root, home), { readonly: true });
  const statement = reader.prepare("SELECT path, excerpt FROM chunks ORDER BY path");
  const rows = statement.all() as Array<{ path: string; excerpt: string }>;
  statement.finalize();
  reader.close(true);
  expect(rows).toEqual([{ path: "stable.ts", excerpt: "last committed snapshot marker\n" }]);
});
