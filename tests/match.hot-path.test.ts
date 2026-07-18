import { expect, spyOn, test } from "bun:test";
import Parser from "tree-sitter";
import { gitStashUntrackedGuard } from "../src/guards";
import { match } from "../src/match";

test("tier-1 keyword misses never invoke the Bash parser", () => {
  const parse = spyOn(Parser.prototype, "parse");
  try {
    const verdict = match(gitStashUntrackedGuard, { chokepoint: "shell", command: "echo harmless" });
    expect(verdict).toEqual({ fired: false });
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});
