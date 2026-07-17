import { expect, test } from "bun:test";
import { assertPublishable } from "../src/growth/npm-publish";

test("publish preflight rejects private and spike packages", () => {
  expect(() => assertPublishable({ private: true, version: "0.0.0-spike" })).toThrow("private");
  expect(() => assertPublishable({ private: false, version: "0.0.0-spike" })).toThrow("spike");
  expect(() => assertPublishable({ private: false, version: "0.1.0" })).not.toThrow();
});
