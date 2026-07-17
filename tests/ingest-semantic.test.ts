import { expect, test } from "bun:test";
import { retrieveContext } from "../src/ingest/semantic";

test("semantic retrieval uses codebase graph then local fallback", async () => {
  expect(await retrieveContext("git stash", async () => ["graph result"], async () => ["local result"])).toEqual({ source: "codebase-memory", results: ["graph result"] });
  expect(await retrieveContext("git stash", async () => { throw new Error("offline"); }, async () => ["local result"])).toEqual({ source: "local", results: ["local result"] });
});
