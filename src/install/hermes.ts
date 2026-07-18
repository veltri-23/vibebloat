import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface HermesHookInstallOptions {
  permitted: boolean;
  hooksDirectory: string;
  configPath?: string;
  sourceDirectory?: string;
}

export function installHermesHook(options: HermesHookInstallOptions): void {
  if (!options.permitted) throw new Error("Explicit setup permission is required.");
  if (!isAbsolute(options.hooksDirectory)) throw new Error("Hermes hooks directory must be absolute.");
  if (options.configPath && !isAbsolute(options.configPath)) throw new Error("Hermes config path must be absolute.");
  const source = options.sourceDirectory ?? join(import.meta.dir, "../../hermes");
  const destination = join(options.hooksDirectory, "vibebloat");
  const handlerPath = join(destination, "handler.py");
  const currentConfig = options.configPath && existsSync(options.configPath) ? readFileSync(options.configPath, "utf8") : "";
  const updatedConfig = options.configPath ? updateHermesConfig(currentConfig, handlerPath) : undefined;
  mkdirSync(destination, { recursive: true });
  copyAtomically(join(source, "HOOK.yaml"), join(destination, "HOOK.yaml"));
  copyAtomically(join(source, "handler.py"), handlerPath);
  if (options.configPath && updatedConfig !== currentConfig) writeAtomically(options.configPath, updatedConfig);
}

function copyAtomically(source: string, destination: string): void {
  const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.tmp`);
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function yamlSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function bridgeLines(indent: string, handlerPath: string): string[] {
  const command = `python "${handlerPath}"`;
  return [
    `${indent}# vibebloat-hermes-pre-tool-call`,
    `${indent}- command: ${yamlSingleQuoted(command)}`,
    `${indent}  matcher: '^(terminal|execute_code|patch|write_file)$'`,
    `${indent}  timeout: 10`,
  ];
}

function isStructuralLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("#");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function sectionEnd(lines: string[], start: number, indent: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isStructuralLine(lines[index]) && indentOf(lines[index]) <= indent) return index;
  }
  return lines.length;
}

function updateHermesConfig(source: string, handlerPath: string): string {
  if (source.includes("vibebloat-hermes-pre-tool-call")) return source;
  const lines = source.length === 0 ? [] : source.replace(/\r?\n$/, "").split(/\r?\n/);
  const hooksCandidate = lines.findIndex((line) => /^hooks\s*:/.test(line));
  if (hooksCandidate >= 0 && !/^hooks\s*:\s*(?:#.*)?$/.test(lines[hooksCandidate])) {
    throw new Error("Hermes hooks must use a block mapping; refusing to overwrite inline hooks.");
  }
  const hooksIndex = hooksCandidate;
  if (hooksIndex < 0) {
    if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
    lines.push("hooks:", "  pre_tool_call:", ...bridgeLines("    ", handlerPath));
    return `${lines.join("\n")}\n`;
  }
  const hooksEnd = sectionEnd(lines, hooksIndex, 0);
  const eventCandidate = lines.findIndex((line, index) => index > hooksIndex && index < hooksEnd && /^  pre_tool_call\s*:/.test(line));
  if (eventCandidate >= 0 && !/^  pre_tool_call\s*:\s*(?:#.*)?$/.test(lines[eventCandidate])) {
    throw new Error("Hermes pre_tool_call hooks must use a block mapping; refusing to overwrite inline hooks.");
  }
  const eventIndex = eventCandidate;
  if (eventIndex < 0) {
    lines.splice(hooksEnd, 0, "  pre_tool_call:", ...bridgeLines("    ", handlerPath));
    return `${lines.join("\n")}\n`;
  }
  const eventEnd = sectionEnd(lines, eventIndex, 2);
  lines.splice(eventEnd, 0, ...bridgeLines("    ", handlerPath));
  return `${lines.join("\n")}\n`;
}

function writeAtomically(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
