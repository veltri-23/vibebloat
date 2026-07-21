import { afterAll, beforeAll, expect, test } from "bun:test";
import { gitStashUntrackedGuard } from "../../src/guards";
import { runPreToolUse } from "../../src/hooks";
import { beforeToolCall } from "../../src/hooks/openclaw-plugin";
import { type DirtyGitContext, restoreCwd, useDirtyGitCwd } from "../helpers/dirty-git-cwd";

let dirtyCtx: DirtyGitContext;
let originalCwd: string;
beforeAll(() => {
  originalCwd = process.cwd();
  dirtyCtx = useDirtyGitCwd();
});
afterAll(() => { restoreCwd(originalCwd, dirtyCtx); });

test("Shot 6: same guard blocks independent agent transports", () => {
  const command = "git stash -u";
  expect(runPreToolUse([gitStashUntrackedGuard], { tool_name: "Bash", tool_input: { command } })).toMatchObject({ exitCode: 2 });
  expect(runPreToolUse([gitStashUntrackedGuard], { toolName: "Bash", toolInput: { command } })).toMatchObject({ exitCode: 2 });
  expect(beforeToolCall([gitStashUntrackedGuard], { toolName: "exec", params: { command } })).toMatchObject({ block: true });
});
