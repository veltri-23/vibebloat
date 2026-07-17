import Parser from "tree-sitter";
import Bash from "tree-sitter-bash";
import type { Event, Guard, Verdict } from "./types";

const parser = new Parser();
parser.setLanguage(Bash);

interface ShellCommand {
  binary: string;
  args: string[];
}

function normalizeBinary(value: string): string {
  return value.replace(/^.*[\\/]/, "");
}

function normalizeCommand(command: string, variables: Record<string, string> = {}): string {
  return command.replace(/\$\{([^}]+)\}|\$(\w+)/g, (match, braced, bare) => {
    const value = variables[braced ?? bare] ?? process.env[braced ?? bare];
    return value ?? match;
  });
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
    const normalizedCommand = normalizeCommand(event.command, event.variables);
    for (const candidate of shellCommands(normalizedCommand)) {
      if (candidate.binary === "git" && candidate.args[0]) {
        candidate.args[0] = event.aliases?.[candidate.args[0]] ?? candidate.args[0];
      }
      if (candidate.binary !== expected[0] || candidate.args[0] !== expected[1]) continue;
      if (candidate.args.includes("--")) continue;
      if (guard.match.argsContains?.every((argument) => candidate.args.includes(argument))) {
        return { fired: true, guardId: guard.id, reason: guard.action.message };
      }
    }
    return { fired: false };
  } catch {
    return parseErrorVerdict(guard);
  }
}
