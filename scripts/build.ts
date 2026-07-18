import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const treeSitterIndex = /node_modules[\\/]tree-sitter[\\/]index\.js$/;
const typeAssignment = "nodeSubclass.prototype.type = typeName;";

const result = await Bun.build({
  entrypoints: [resolve(root, "src/cli.ts")],
  compile: { outfile: resolve(root, "dist/vibebloat") },
  define: { VIBEBLOAT_STANDALONE: "true" },
  plugins: [{
    name: "tree-sitter-standalone",
    setup(build) {
      build.onResolve({ filter: /^node-gyp-build$/ }, () => ({ path: resolve(root, "src/parser/node-gyp-build.cjs") }));
      build.onLoad({ filter: treeSitterIndex }, async (args) => {
        const source = await Bun.file(args.path).text();
        if (!source.includes(typeAssignment)) throw new Error("Unsupported tree-sitter runtime source.");
        return {
          contents: source.replace(typeAssignment, "// Bun standalone runs in strict mode; inherited type getter remains correct."),
          loader: "js",
        };
      });
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
