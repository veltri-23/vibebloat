import { closeSync, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClaudeJsonl } from "./cc-jsonl";
import { parseCodexJsonl } from "./codex-jsonl";
import { parseHermesHistory } from "./hermes-history";
import type { HistoryChunk, HistorySource } from "./types";

const defaultStaleDays = 90;

export interface HistorySourceSummary {
  id: HistorySource;
  label: "Claude Code" | "Codex" | "Hermes";
  fileCount: number;
  lastActivityAt: string;
  daysSinceActivity: number;
  stale: boolean;
  selectedByDefault: boolean;
}

export interface HistoryLoadRequest {
  confirmed: boolean;
  scrubbersVerified: boolean;
  sourceIds: readonly HistorySource[];
}

export interface LocalHistoryCatalog {
  sources: readonly HistorySourceSummary[];
  loadConfirmed(request: HistoryLoadRequest): HistoryChunk[];
}

export interface HistoryDiscoveryOptions {
  homeDirectory: string;
  claudeHome?: string;
  codexHome?: string;
  hermesHome?: string;
  now?: Date;
  staleAfterDays?: number;
}

interface SourceFiles {
  id: HistorySource;
  label: HistorySourceSummary["label"];
  files: DiscoveredFile[];
  parse(input: string, filename: string): HistoryChunk[];
}

interface DiscoveredFile {
  path: string;
  device: number;
  inode: number;
  size: number;
  modifiedAt: number;
  changedAt: number;
}

function regularFile(path: string): DiscoveredFile | undefined {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink()
      ? { path, device: stat.dev, inode: stat.ino, size: stat.size, modifiedAt: stat.mtimeMs, changedAt: stat.ctimeMs }
      : undefined;
  } catch {
    return undefined;
  }
}

function collectFiles(root: string, extension: ".json" | ".jsonl"): DiscoveredFile[] {
  if (!existsSync(root)) return [];
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  const pending = [root];
  const files: DiscoveredFile[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(extension)) {
        const file = regularFile(path);
        if (file) files.push(file);
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function sourceFiles(options: HistoryDiscoveryOptions): SourceFiles[] {
  const claudeHome = options.claudeHome ?? join(options.homeDirectory, ".claude");
  const codexHome = options.codexHome ?? join(options.homeDirectory, ".codex");
  const hermesHome = options.hermesHome ?? join(options.homeDirectory, ".hermes");
  const codexHistory = regularFile(join(codexHome, "history.jsonl"));
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      files: collectFiles(join(claudeHome, "projects"), ".jsonl"),
      parse: parseClaudeJsonl,
    },
    {
      id: "codex",
      label: "Codex",
      files: [
        ...(codexHistory ? [codexHistory] : []),
        ...collectFiles(join(codexHome, "sessions"), ".jsonl"),
      ].sort((left, right) => left.path.localeCompare(right.path)),
      parse: parseCodexJsonl,
    },
    {
      id: "hermes",
      label: "Hermes",
      files: collectFiles(join(hermesHome, "profiles"), ".json")
        .filter((file) => /[\\/]sessions[\\/][^\\/]+\.json$/.test(file.path)),
      parse: parseHermesHistory,
    },
  ];
}

function latestModifiedAt(files: readonly DiscoveredFile[]): Date | undefined {
  let latest: Date | undefined;
  for (const file of files) {
    try {
      const modifiedAt = lstatSync(file.path).mtime;
      if (!latest || modifiedAt > latest) latest = modifiedAt;
    } catch {
      continue;
    }
  }
  return latest;
}

function readDiscoveredFile(file: DiscoveredFile): string {
  const descriptor = openSync(file.path, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()
      || stat.dev !== file.device
      || stat.ino !== file.inode
      || stat.size !== file.size
      || stat.mtimeMs !== file.modifiedAt
      || stat.ctimeMs !== file.changedAt) {
      throw new Error("History file changed after discovery.");
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

export function discoverLocalHistory(options: HistoryDiscoveryOptions): LocalHistoryCatalog {
  const staleAfterDays = options.staleAfterDays ?? defaultStaleDays;
  if (!Number.isSafeInteger(staleAfterDays) || staleAfterDays < 1) throw new Error("Stale history threshold must be a positive integer.");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("History discovery time is invalid.");
  const discovered = sourceFiles(options).filter((source) => source.files.length > 0);
  const byId = new Map(discovered.map((source) => [source.id, source]));
  const sources = discovered.flatMap((source) => {
    const lastActivity = latestModifiedAt(source.files);
    if (!lastActivity) return [];
    const daysSinceActivity = Math.max(0, Math.floor((now.getTime() - lastActivity.getTime()) / 86_400_000));
    const stale = daysSinceActivity >= staleAfterDays;
    return [{
      id: source.id,
      label: source.label,
      fileCount: source.files.length,
      lastActivityAt: lastActivity.toISOString(),
      daysSinceActivity,
      stale,
      selectedByDefault: !stale,
    }];
  });

  return {
    sources,
    loadConfirmed(request): HistoryChunk[] {
      if (!request.confirmed) throw new Error("History sources require explicit confirmation before reading.");
      if (!request.scrubbersVerified) throw new Error("History cannot be read until local scrubbers are verified.");
      if (new Set(request.sourceIds).size !== request.sourceIds.length) throw new Error("History source selection contains duplicates.");
      const selected = request.sourceIds.map((id) => {
        const source = byId.get(id);
        if (!source) throw new Error("History source selection is unavailable.");
        return source;
      });
      try {
        return selected.flatMap((source) => source.files.flatMap((file) => source.parse(readDiscoveredFile(file), file.path)));
      } catch {
        throw new Error("Confirmed history could not be parsed.");
      }
    },
  };
}
