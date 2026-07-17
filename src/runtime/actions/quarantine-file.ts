import { existsSync, renameSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import type { ActionOutcome } from "./types";

export function quarantineFile(source: string | undefined, target: string | undefined, message: string): ActionOutcome {
  if (!source || !existsSync(source)) return { blocked: true, reason: message };
  const quarantinePath = target ?? join(dirname(source), `.${basename(source)}.vibebloat-quarantine`);
  renameSync(source, quarantinePath);
  return { blocked: true, reason: message, quarantinedPath: quarantinePath };
}
