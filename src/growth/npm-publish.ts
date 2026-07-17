export function assertPublishable(packageJson: { private?: boolean; version: string }): void {
  if (packageJson.private) throw new Error("Package is private.");
  if (packageJson.version.includes("spike")) throw new Error("Package version is still spike-only.");
}
