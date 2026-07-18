import { fileURLToPath } from "node:url";
import { runShellShimCommand } from "./shell-shim-handler";

const [gitExecutable, ...arguments_] = process.argv.slice(2);
process.exit(runShellShimCommand(gitExecutable, arguments_, {
  cliCommand: [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))],
}));
