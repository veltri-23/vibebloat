import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";

const filename = "email.json";

export function saveEmail(directory: string, email: string): void {
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error("Email address is invalid.");
  replaceGuardAtomically(join(directory, filename), `${JSON.stringify({ email })}\n`);
}

export function loadEmail(directory: string): string | undefined {
  const path = join(directory, filename);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { email: string }).email : undefined;
}

export function forgetEmail(directory: string): void {
  rmSync(join(directory, filename), { force: true });
}
