import { fileURLToPath } from "node:url";

declare const VIBEBLOAT_STANDALONE: boolean | undefined;

export function cliSelfCommand(): string[] {
  return typeof VIBEBLOAT_STANDALONE !== "undefined" && VIBEBLOAT_STANDALONE
    ? [process.execPath]
    : [process.execPath, fileURLToPath(new URL("cli.ts", import.meta.url))];
}
