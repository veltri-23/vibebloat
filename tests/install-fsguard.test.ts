import { expect, test } from "bun:test";
import { mcpConfigWrongFileGuard } from "../src/guards";
import { evaluateFsWrite } from "../src/install/fs-guard";

test("filesystem fallback blocks wrong MCP config write", () => {
  expect(evaluateFsWrite([mcpConfigWrongFileGuard], "C:/repo/.mcp.json")).toMatchObject({ exitCode: 2 });
});
