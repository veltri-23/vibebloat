import { expect, spyOn, test } from "bun:test";
import Parser from "tree-sitter";
import { gitStashUntrackedGuard } from "../src/guards";
import { match } from "../src/match";

test("tier-1 keyword misses skip the Bash parser for fail-open classes", () => {
  const parse = spyOn(Parser.prototype, "parse");
  try {
    const verdict = match({ ...gitStashUntrackedGuard, class: "B" }, { chokepoint: "shell", command: "echo harmless" });
    expect(verdict).toEqual({ fired: false });
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
});

test("Class A keyword misses parse before they fail open", () => {
  const parse = spyOn(Parser.prototype, "parse");
  try {
    expect(match(gitStashUntrackedGuard, { chokepoint: "shell", command: "echo harmless" })).toEqual({ fired: false });
    expect(parse).toHaveBeenCalledTimes(1);
  } finally {
    parse.mockRestore();
  }
});
