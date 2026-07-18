import { resolve } from "node:path";

export function shellShimOwnershipLine(realGitExecutable: string, windows = false): string {
  const encoded = Buffer.from(resolve(realGitExecutable), "utf8").toString("base64url");
  return `${windows ? "rem" : "#"} vibebloat:git-shim real-git=${encoded}`;
}
