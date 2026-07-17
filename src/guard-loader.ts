import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGuard } from "./schema";
import type { Guard } from "./types";

export function loadGuards(directory: string): Guard[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseGuard(JSON.parse(readFileSync(join(directory, file), "utf8"))));
}
