import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface HermesHookInstallOptions {
  permitted: boolean;
  hooksDirectory: string;
  sourceDirectory?: string;
}

export function installHermesHook(options: HermesHookInstallOptions): void {
  if (!options.permitted) throw new Error("Explicit setup permission is required.");
  const source = options.sourceDirectory ?? join(import.meta.dir, "../../hermes");
  const destination = join(options.hooksDirectory, "vibebloat");
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(source, "HOOK.yaml"), join(destination, "HOOK.yaml"));
  copyFileSync(join(source, "handler.py"), join(destination, "handler.py"));
}
