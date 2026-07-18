import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverLocalHistory } from "../src/ingest/discovery";

const roots: string[] = [];
const now = new Date("2026-07-18T12:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = mkdtempSync(join(process.env.TEMP ?? ".", "vibebloat-discovery-"));
  roots.push(root);
  return root;
}

function write(path: string, value: string, modifiedAt = now): void {
  mkdirSync(path.replace(/[\\/][^\\/]+$/, ""), { recursive: true });
  writeFileSync(path, value);
  utimesSync(path, modifiedAt, modifiedAt);
}

test("discovery reports source metadata without exposing local paths", () => {
  const root = home();
  write(join(root, ".claude", "projects", "project", "session.jsonl"), '{"type":"user","sessionId":"cc","message":{"role":"user","content":"one"}}\n');
  write(join(root, ".codex", "sessions", "2026", "session.jsonl"), '{"session_id":"cx","message":{"role":"user","content":"two"}}\n', new Date("2026-04-18T12:00:00.000Z"));
  write(join(root, ".hermes", "profiles", "default", "sessions", "error.json"), '{"session_id":"hx","request":{"body":{"messages":[{"role":"user","content":"three"}]}}}');

  const catalog = discoverLocalHistory({ homeDirectory: root, now });

  expect(catalog.sources.map(({ id, stale, selectedByDefault }) => ({ id, stale, selectedByDefault }))).toEqual([
    { id: "claude-code", stale: false, selectedByDefault: true },
    { id: "codex", stale: true, selectedByDefault: false },
    { id: "hermes", stale: false, selectedByDefault: true },
  ]);
  expect(JSON.stringify(catalog.sources)).not.toContain(root);
});

test("history stays unread until confirmation and scrubber verification", () => {
  const root = home();
  write(join(root, ".hermes", "profiles", "default", "sessions", "error.json"), "not json");
  const catalog = discoverLocalHistory({ homeDirectory: root, now });

  expect(() => catalog.loadConfirmed({ confirmed: false, scrubbersVerified: true, sourceIds: ["hermes"] }))
    .toThrow("explicit confirmation");
  expect(() => catalog.loadConfirmed({ confirmed: true, scrubbersVerified: false, sourceIds: ["hermes"] }))
    .toThrow("scrubbers are verified");
  expect(() => catalog.loadConfirmed({ confirmed: true, scrubbersVerified: true, sourceIds: ["hermes"] }))
    .toThrow("could not be parsed");
});

test("confirmed catalog loads each native history shape with stable source ids", () => {
  const root = home();
  write(join(root, ".claude", "projects", "project", "claude.jsonl"), '{"type":"user","sessionId":"cc","message":{"role":"user","content":"one"}}\n');
  write(join(root, ".codex", "history.jsonl"), '{"session_id":"cx","message":{"role":"assistant","content":"two"}}\n');
  write(join(root, ".hermes", "profiles", "default", "sessions", "hermes.json"), '{"session_id":"hx","request":{"body":{"messages":[{"role":"user","content":"three"}]}}}');
  const catalog = discoverLocalHistory({ homeDirectory: root, now });

  const chunks = catalog.loadConfirmed({
    confirmed: true,
    scrubbersVerified: true,
    sourceIds: ["claude-code", "codex", "hermes"],
  });

  expect(chunks.map(({ source, sessionId, content }) => ({ source, sessionId, content }))).toEqual([
    { source: "claude-code", sessionId: "cc", content: "one" },
    { source: "codex", sessionId: "cx", content: "two" },
    { source: "hermes", sessionId: "hx", content: "three" },
  ]);
});

test("catalog fails closed when a discovered file is replaced before load", () => {
  const root = home();
  const history = join(root, ".codex", "history.jsonl");
  write(history, '{"session_id":"safe","message":{"content":"safe"}}\n');
  const catalog = discoverLocalHistory({ homeDirectory: root, now });
  rmSync(history);
  write(history, '{"session_id":"swapped","message":{"content":"swapped"}}\n');

  expect(() => catalog.loadConfirmed({ confirmed: true, scrubbersVerified: true, sourceIds: ["codex"] }))
    .toThrow("could not be parsed");
});

test("discovery skips symlinked history trees", () => {
  if (process.platform === "win32") return;
  const root = home();
  const outside = home();
  write(join(outside, "leak.jsonl"), '{"type":"user","message":{"content":"secret"}}\n');
  mkdirSync(join(root, ".claude"), { recursive: true });
  symlinkSync(outside, join(root, ".claude", "projects"), "dir");

  expect(discoverLocalHistory({ homeDirectory: root, now }).sources).toEqual([]);
});
