import { expect, spyOn, test } from "bun:test";
import Parser from "tree-sitter";
import { gitStashUntrackedGuard } from "../src/guards";
import { match } from "../src/match";

test("huge heredocs are bounded before the Bash parser can exhaust memory", () => {
  const parse = spyOn(Parser.prototype, "parse");
  const command = `cat <<'PAYLOAD'\n${"x".repeat(128 * 1024)}\nPAYLOAD`;

  try {
    expect(match(gitStashUntrackedGuard, { chokepoint: "shell", command, hasUnstagedChanges: true })).toMatchObject({
      fired: true,
      parseError: true,
    });
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test("parser memory exhaustion follows the locked per-class policy", () => {
  const parse = spyOn(Parser.prototype, "parse").mockImplementation(() => {
    throw new RangeError("Out of memory");
  });
  const event = { chokepoint: "shell" as const, command: "git stash -u", hasUnstagedChanges: true };

  try {
    expect(match(gitStashUntrackedGuard, event)).toMatchObject({ fired: true, parseError: true });
    for (const guardClass of ["B", "C", "D"] as const) {
      expect(match({ ...gitStashUntrackedGuard, class: guardClass }, event)).toMatchObject({
        fired: false,
        parseError: true,
      });
    }
  } finally {
    parse.mockRestore();
  }
});
