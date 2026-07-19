import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import type { Event, Guard, Verdict } from "./types";

const parser = new Parser();
parser.setLanguage(Bash);
const maxShellCommandBytes = 64 * 1024;

interface ShellCommand {
  binary: string;
  args: string[];
}

const gitGlobalOptionsWithValue = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const gitGlobalOptionsBare = new Set(["-p", "-P", "--paginate", "--no-pager", "--bare", "--no-replace-objects", "--literal-pathspecs", "--no-optional-locks"]);

function stripGitGlobalOptions(args: string[]): void {
  while (args.length) {
    const first = args[0];
    if (gitGlobalOptionsWithValue.has(first)) { args.splice(0, 2); continue; }
    if (gitGlobalOptionsBare.has(first) || [...gitGlobalOptionsWithValue].some((option) => first.startsWith(`${option}=`))) { args.splice(0, 1); continue; }
    break;
  }
}

function argMatches(args: readonly string[], wanted: string): boolean {
  if (args.includes(wanted)) return true;
  if (!/^-[A-Za-z]$/.test(wanted)) return false;
  const letter = wanted[1];
  return args.some((argument) => /^-[A-Za-z]+$/.test(argument) && argument.includes(letter));
}

function normalizeBinary(value: string): string {
  return value.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat)$/i, "");
}

function normalizeCommand(command: string, variables: Record<string, string> = {}): string {
  if (!command.includes("$")) return command;

  const parts: string[] = [];
  let bytes = 0;
  let lastIndex = 0;
  const append = (value: string): void => {
    bytes += Buffer.byteLength(value, "utf8");
    if (bytes > maxShellCommandBytes) throw new Error("Shell command exceeds parser input limit.");
    parts.push(value);
  };
  for (const match of command.matchAll(/\$\{([^}]+)\}|\$(\w+)/g)) {
    const index = match.index ?? 0;
    append(command.slice(lastIndex, index));
    const name = match[1] ?? match[2];
    append(variables[name] ?? process.env[name] ?? match[0]);
    lastIndex = index + match[0].length;
  }
  append(command.slice(lastIndex));
  return parts.join("");
}

function hasCommandKeyword(command: string, binary: string): boolean {
  let index = command.indexOf(binary);
  while (index >= 0) {
    const before = command.charCodeAt(index - 1);
    const after = command.charCodeAt(index + binary.length);
    const startsOnBoundary = index === 0 || !isIdentifierCharacter(before);
    const endsOnBoundary = index + binary.length === command.length || !isIdentifierCharacter(after);
    if (startsOnBoundary && endsOnBoundary) return true;
    index = command.indexOf(binary, index + binary.length);
  }
  return false;
}

function isIdentifierCharacter(character: number): boolean {
  return (character >= 48 && character <= 57)
    || (character >= 65 && character <= 90)
    || character === 95
    || (character >= 97 && character <= 122);
}

function exceedsShellCommandLimit(command: string): boolean {
  return Buffer.byteLength(command, "utf8") > maxShellCommandBytes;
}

function hasObviousSyntaxError(command: string): boolean {
  let quote: "'" | '"' | undefined;
  let substitutions = 0;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\\") { index += 1; continue; }
    if (quote) { if (character === quote) quote = undefined; continue; }
    if (character === "#" && (index === 0 || /\s/.test(command[index - 1]))) break;
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "$" && command[index + 1] === "(") { substitutions += 1; index += 1; continue; }
    if (character === ")" && substitutions > 0) substitutions -= 1;
  }
  return quote !== undefined || substitutions !== 0;
}

function tokenize(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (word) words.push(word);
      word = "";
      continue;
    }
    word += character;
  }
  if (quote) throw new Error("unterminated quote");
  if (word) words.push(word);
  return words;
}

function shellCommands(command: string): ShellCommand[] {
  const tree = parser.parse(command);
  if (tree.rootNode.hasError) throw new Error("shell parse failed");

  const commands: ShellCommand[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "command") {
      const words = tokenize(node.text);
      if (words.length) commands.push({ binary: normalizeBinary(words[0]), args: words.slice(1) });
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return commands;
}

function parseErrorVerdict(guard: Guard): Verdict {
  if (guard.class === "A") {
    return { fired: true, guardId: guard.id, reason: "Shell parse failed for Class A guard.", parseError: true };
  }
  return { fired: false, parseError: true };
}

export function match(guard: Guard, event: Event): Verdict {
  if (!guard.enabled || guard.match.chokepoint !== event.chokepoint) return { fired: false };

  if (event.chokepoint === "file") {
    const path = event.path?.replace(/\\/g, "/").replace(/^.*\//, "");
    return path === guard.match.path
      ? { fired: true, guardId: guard.id, reason: guard.action.message }
      : { fired: false };
  }

  if (!event.command || !guard.match.command) return { fired: false };
  try {
    const expected = guard.match.command.split(" ");
    if (exceedsShellCommandLimit(event.command)) return parseErrorVerdict(guard);
    const normalizedCommand = normalizeCommand(event.command, event.variables);
    if (exceedsShellCommandLimit(normalizedCommand)) return parseErrorVerdict(guard);
    if (hasObviousSyntaxError(normalizedCommand)) return parseErrorVerdict(guard);
    const parsedCommands = guard.class === "A" ? shellCommands(normalizedCommand) : undefined;
    if (!hasCommandKeyword(normalizedCommand, expected[0])) return { fired: false };
    for (const candidate of parsedCommands ?? shellCommands(normalizedCommand)) {
      if (candidate.binary === "git" && candidate.args[0]) {
        stripGitGlobalOptions(candidate.args);
        if (event.aliasResolutionFailed) throw new Error("Git alias normalization could not read local configuration.");
        const alias = candidate.args[0] ? event.aliases?.[candidate.args[0]] : undefined;
        if (alias) {
          if (alias.trimStart().startsWith("!")) throw new Error("Git shell aliases cannot be normalized safely.");
          const expansion = tokenize(alias);
          if (!expansion.length) throw new Error("Git alias has no command expansion.");
          candidate.args.splice(0, 1, ...expansion);
        }
      }
      if (candidate.binary !== expected[0] || candidate.args[0] !== expected[1]) continue;
      const doubleDash = candidate.args.indexOf("--");
      if (candidate.binary === "git" && doubleDash >= 0 && doubleDash < candidate.args.length - 1) continue;
      const containsRequiredArgs = !guard.match.argsContains || guard.match.argsContains.every((argument) => argMatches(candidate.args, argument));
      const containsAnyRiskyArg = !guard.match.argsAnyOf || guard.match.argsAnyOf.some((argument) => argMatches(candidate.args, argument));
      if (containsRequiredArgs && containsAnyRiskyArg) {
        return { fired: true, guardId: guard.id, reason: guard.action.message };
      }
    }
    return { fired: false };
  } catch {
    return parseErrorVerdict(guard);
  }
}
