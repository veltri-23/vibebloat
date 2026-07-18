function runtimeBinding() {
  if (process.platform === "win32" && process.arch === "x64") return require("../../node_modules/tree-sitter/prebuilds/win32-x64/tree-sitter.node");
  if (process.platform === "linux" && process.arch === "x64") return require("../../node_modules/tree-sitter/prebuilds/linux-x64/tree-sitter.node");
  if (process.platform === "darwin" && process.arch === "x64") return require("../../node_modules/tree-sitter/prebuilds/darwin-x64/tree-sitter.node");
  if (process.platform === "darwin" && process.arch === "arm64") return require("../../node_modules/tree-sitter/prebuilds/darwin-arm64/tree-sitter.node");
  throw new Error(`Unsupported Tree-sitter platform: ${process.platform}-${process.arch}`);
}

function bashBinding() {
  if (process.platform === "win32" && process.arch === "x64") return require("../../node_modules/tree-sitter-bash/prebuilds/win32-x64/tree-sitter-bash.node");
  if (process.platform === "linux" && process.arch === "x64") return require("../../node_modules/tree-sitter-bash/prebuilds/linux-x64/tree-sitter-bash.node");
  if (process.platform === "darwin" && process.arch === "x64") return require("../../node_modules/tree-sitter-bash/prebuilds/darwin-x64/tree-sitter-bash.node");
  if (process.platform === "darwin" && process.arch === "arm64") return require("../../node_modules/tree-sitter-bash/prebuilds/darwin-arm64/tree-sitter-bash.node");
  throw new Error(`Unsupported Tree-sitter platform: ${process.platform}-${process.arch}`);
}

module.exports = (directory) => directory.includes("tree-sitter-bash") ? bashBinding() : runtimeBinding();
