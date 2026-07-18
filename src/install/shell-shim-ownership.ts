import { resolve } from "node:path";

const posixPrefix = "# vibebloat:git-shim real-git=";
const windowsPrefix = "rem vibebloat:git-shim real-git=";

export function shellShimOwnershipLine(realGitExecutable: string, windows = false): string {
  const encoded = Buffer.from(resolve(realGitExecutable), "utf8").toString("base64url");
  return `${windows ? windowsPrefix : posixPrefix}${encoded}`;
}

export function ownedShellShimTarget(source: string, windows = false): string | undefined {
  const prefix = windows ? windowsPrefix : posixPrefix;
  const line = source.split(/\r?\n/, 3)[1];
  if (!line?.startsWith(prefix)) return undefined;
  const encoded = line.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    return decoded && resolve(decoded) === decoded ? decoded : undefined;
  } catch {
    return undefined;
  }
}
