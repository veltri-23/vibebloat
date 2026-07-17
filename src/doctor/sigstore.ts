export function verifySigstore(binaryPath: string, publicKeyPath: string, run: (command: string[]) => number): boolean {
  return run(["cosign", "verify-blob", "--key", publicKeyPath, "--signature", `${binaryPath}.sig`, binaryPath]) === 0;
}
