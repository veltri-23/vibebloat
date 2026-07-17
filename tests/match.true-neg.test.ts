import { expect, test } from "bun:test";
import { gitStashUntrackedGuard } from "../src/guards";
import { match } from "../src/match";

test.each([
  "git stash -u -- src/file.ts",
  'echo "git stash -u"',
  "cat <<'EOF'\ngit stash -u\nEOF",
])("does not fire on true-negative: %s", (command) => {
  expect(match(gitStashUntrackedGuard, { chokepoint: "shell", command })).toMatchObject({ fired: false });
});
