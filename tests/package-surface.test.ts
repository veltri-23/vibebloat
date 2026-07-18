import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  exports?: Record<string, string>;
  engines?: { bun?: string };
  files?: string[];
  openclaw?: {
    compat?: { pluginApi?: string };
    extensions?: string[];
    runtimeExtensions?: string[];
  };
  peerDependencies?: Record<string, string>;
  private?: boolean;
  scripts?: Record<string, string>;
  private?: boolean;
};
const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
  configSchema?: { additionalProperties?: boolean; type?: string };
  id?: string;
};
const npmIgnore = readFileSync(new URL("../.npmignore", import.meta.url), "utf8");

test("npm package ships an installable OpenClaw plugin", () => {
  expect(packageJson.files).toEqual(["bin", "dist/openclaw-plugin.js", "src", "hermes/HOOK.yaml", "hermes/handler.py", "openclaw.plugin.json", "LICENSE", "NOTICE", "README.md"]);
  expect(packageJson.engines?.bun).toBe(">=1.3.0");
  expect(packageJson.private).toBeUndefined();
  expect(packageJson.scripts?.["build:openclaw"]).toBe("bun build src/hooks/openclaw-plugin.ts --outdir dist --target bun");
  expect(packageJson.scripts?.prepack).toBe("bun run build:openclaw");
  expect(packageJson.private).toBeTrue();
  expect(packageJson.exports?.["./openclaw-plugin"]).toBe("./dist/openclaw-plugin.js");
  expect(packageJson.peerDependencies?.openclaw).toBe(">=2026.4.0");
  expect(packageJson.openclaw).toEqual({
    extensions: ["./src/hooks/openclaw-plugin.ts"],
    runtimeExtensions: ["./dist/openclaw-plugin.js"],
    compat: { pluginApi: ">=2026.4.0" },
  });
  expect(manifest.id).toBe("vibebloat");
  expect(manifest.configSchema).toEqual({ type: "object", additionalProperties: false });
  expect(npmIgnore).toContain("dist/*.exe");
  expect(npmIgnore).toContain("hermes/__pycache__/");
});
