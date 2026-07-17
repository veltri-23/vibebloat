import { join } from "node:path";
import { replaceGuardAtomically } from "./live-compile";

export interface Proof {
  status: "pass" | "fail" | "skip";
  cases: string[];
}

export function writeProof(directory: string, proof: Proof): void {
  replaceGuardAtomically(join(directory, "proof.json"), `${JSON.stringify(proof)}\n`);
}
