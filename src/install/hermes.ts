import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface HermesHookInstallOptions {
  permitted: boolean;
  hermesHome: string;
  pythonExecutable: string;
  sourceDirectory?: string;
}

export function installHermesHook(options: HermesHookInstallOptions): void {
  if (!options.permitted) throw new Error("Explicit setup permission is required.");
  if (!isAbsolute(options.hermesHome)) throw new Error("Hermes home must be absolute.");
  if (!existsSync(options.hermesHome) || !statSync(options.hermesHome).isDirectory()) throw new Error("Hermes home must be an existing directory.");
  if (!isAbsolute(options.pythonExecutable) || !existsSync(options.pythonExecutable) || !statSync(options.pythonExecutable).isFile()) {
    throw new Error("Hermes Python interpreter must be an existing absolute file.");
  }
  const source = options.sourceDirectory ?? join(import.meta.dir, "../../hermes");
  const hooksDirectory = join(options.hermesHome, "hooks");
  const configPath = join(options.hermesHome, "config.yaml");
  const allowlistPath = join(options.hermesHome, "shell-hooks-allowlist.json");
  const destination = join(hooksDirectory, "vibebloat");
  const handlerPath = join(destination, "handler.py");
  const handlerSource = join(source, "handler.py");
  const handlerDigest = createHash("sha256").update(readFileSync(handlerSource)).digest("hex");
  const command = bridgeCommand(options.pythonExecutable, handlerPath, handlerDigest);
  const currentConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const currentAllowlist = existsSync(allowlistPath) ? readFileSync(allowlistPath, "utf8") : "";
  const updatedConfig = updateHermesConfig(currentConfig, command);
  assertHermesAllowlist(currentAllowlist);
  mkdirSync(destination, { recursive: true });
  copyAtomically(join(source, "HOOK.yaml"), join(destination, "HOOK.yaml"));
  copyAtomically(handlerSource, handlerPath);
  const updatedAllowlist = updateHermesAllowlist(currentAllowlist, command, handlerPath);
  if (updatedAllowlist !== currentAllowlist) writeAtomically(allowlistPath, updatedAllowlist);
  if (updatedConfig !== currentConfig) writeAtomically(configPath, updatedConfig);
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

function bridgeLines(indent: string, command: string): string[] {
  return [
    `${indent}# vibebloat-hermes-pre-tool-call`,
    `${indent}- command: ${yamlSingleQuoted(command)}`,
    `${indent}  matcher: '^(terminal|execute_code|patch|write_file)$'`,
    `${indent}  timeout: 10`,
  ];
}

function bridgeCommand(pythonExecutable: string, handlerPath: string, handlerDigest: string): string {
  return `"${pythonExecutable}" "${handlerPath}" --vibebloat-handler-sha=${handlerDigest}`;
}

interface HermesAllowlist {
  approvals: unknown[];
  [key: string]: unknown;
}

function parseHermesAllowlist(source: string): HermesAllowlist {
  if (!source.trim()) return { approvals: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Hermes shell-hook allowlist must be valid JSON; refusing to overwrite it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hermes shell-hook allowlist must be a JSON object; refusing to overwrite it.");
  }
  const allowlist = parsed as HermesAllowlist;
  if (allowlist.approvals === undefined) allowlist.approvals = [];
  if (!Array.isArray(allowlist.approvals)) {
    throw new Error("Hermes shell-hook allowlist approvals must be an array; refusing to overwrite it.");
  }
  return allowlist;
}

function assertHermesAllowlist(source: string): void {
  parseHermesAllowlist(source);
}

function updateHermesAllowlist(source: string, command: string, handlerPath: string): string {
  const allowlist = parseHermesAllowlist(source);
  const alreadyApproved = allowlist.approvals.some((approval) => (
    typeof approval === "object" && approval !== null
      && (approval as Record<string, unknown>).event === "pre_tool_call"
      && (approval as Record<string, unknown>).command === command
  ));
  if (alreadyApproved) return source;
  allowlist.approvals.push({
    event: "pre_tool_call",
    command,
    approved_at: new Date().toISOString(),
    script_mtime_at_approval: statSync(handlerPath).mtime.toISOString(),
  });
  return `${JSON.stringify(allowlist, null, 2)}\n`;
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

function updateHermesConfig(source: string, command: string): string {
  const lines = source.length === 0 ? [] : source.replace(/\r?\n$/, "").split(/\r?\n/);
  const hooksCandidate = lines.findIndex((line) => /^hooks\s*:/.test(line));
  if (hooksCandidate >= 0 && !/^hooks\s*:\s*(?:#.*)?$/.test(lines[hooksCandidate])) {
    throw new Error("Hermes hooks must use a block mapping; refusing to overwrite inline hooks.");
  }
  const hooksIndex = hooksCandidate;
  if (hooksIndex < 0) {
    if (lines.length > 0 && lines.at(-1)?.trim() !== "") lines.push("");
    lines.push("hooks:", "  pre_tool_call:", ...bridgeLines("    ", command));
    return `${lines.join("\n")}\n`;
  }
  const hooksEnd = sectionEnd(lines, hooksIndex, 0);
  const eventCandidate = lines.findIndex((line, index) => index > hooksIndex && index < hooksEnd && /^  pre_tool_call\s*:/.test(line));
  if (eventCandidate >= 0 && !/^  pre_tool_call\s*:\s*(?:#.*)?$/.test(lines[eventCandidate])) {
    throw new Error("Hermes pre_tool_call hooks must use a block mapping; refusing to overwrite inline hooks.");
  }
  const eventIndex = eventCandidate;
  if (eventIndex < 0) {
    lines.splice(hooksEnd, 0, "  pre_tool_call:", ...bridgeLines("    ", command));
    return `${lines.join("\n")}\n`;
  }
  const eventEnd = sectionEnd(lines, eventIndex, 2);
  const markerIndex = lines.findIndex((line, index) => index > eventIndex && index < eventEnd && line.trim() === "# vibebloat-hermes-pre-tool-call");
  if (markerIndex >= 0) {
    const indent = lines[markerIndex].slice(0, indentOf(lines[markerIndex]));
    const bridge = lines.slice(markerIndex, markerIndex + 4);
    if (bridge.length !== 4 || !bridge[1]?.startsWith(`${indent}- command:`) || !bridge[2]?.startsWith(`${indent}  matcher:`) || !bridge[3]?.startsWith(`${indent}  timeout:`)) {
      throw new Error("VibeBloat Hermes pre-tool bridge is malformed; refusing to overwrite it.");
    }
    lines.splice(markerIndex, 4, ...bridgeLines(indent, command));
    return `${lines.join("\n")}\n`;
  }
  lines.splice(eventEnd, 0, ...bridgeLines("    ", command));
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
