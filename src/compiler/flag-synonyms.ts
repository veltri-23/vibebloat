/**
 * Equivalent spellings of the same destructive flag.
 *
 * An incident is mined from one spelling — whatever the user happened to type
 * that day — but the guard has to cover the operation, not the keystrokes. A
 * rule learned from `git stash -u` that lets `git stash --include-untracked`
 * through is a rule the user will discover the hard way, twice.
 *
 * Scoped by command prefix on purpose: `-v` means --volumes to docker compose
 * and --verbose almost everywhere else, and a wrong expansion blocks work the
 * user never asked us to block.
 */
const synonymsByCommand: Array<{ command: string; groups: string[][] }> = [
  { command: "git stash", groups: [["-u", "--include-untracked"], ["-a", "--all"]] },
  { command: "git clean", groups: [["-f", "--force"], ["-d"], ["-x"]] },
  { command: "git push", groups: [["-f", "--force", "--force-with-lease"]] },
  { command: "git branch", groups: [["-D", "--delete --force"]] },
  { command: "git checkout", groups: [["-f", "--force"]] },
  { command: "git reset", groups: [["--hard"]] },
  { command: "docker compose", groups: [["-v", "--volumes"]] },
  { command: "docker-compose", groups: [["-v", "--volumes"]] },
  { command: "rm", groups: [["-r", "-R", "--recursive"], ["-f", "--force"]] },
  { command: "npm", groups: [["-f", "--force"]] },
];

/**
 * All spellings equivalent to `flag` for `command`, including the flag itself.
 * Returns just the flag when nothing is known — never guesses.
 */
export function flagSpellings(command: string, flag: string): string[] {
  const normalized = command.trim().toLowerCase();
  const entry = synonymsByCommand.find(({ command: prefix }) => normalized === prefix || normalized.startsWith(`${prefix} `));
  const group = entry?.groups.find((spellings) => spellings.includes(flag));
  return group && group.length > 1 ? [...group] : [flag];
}

/**
 * Widens a single-flag requirement to every equivalent spelling.
 *
 * Only single-flag incidents are widened: the guard schema expresses "all of
 * argsContains" or "any of argsAnyOf", and a multi-flag incident needs an AND
 * of ORs that it cannot represent. Those keep exact-match semantics rather
 * than being silently loosened.
 */
export function widenArgs(
  command: string | undefined,
  args: readonly string[] | undefined,
): { argsContains?: string[]; argsAnyOf?: string[] } {
  if (!args?.length) return {};
  if (!command || args.length !== 1) return { argsContains: [...args] };
  const spellings = flagSpellings(command, args[0]!);
  return spellings.length > 1 ? { argsAnyOf: spellings } : { argsContains: [...args] };
}
