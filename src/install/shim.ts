export type Shell = "bash" | "zsh" | "fish" | "pwsh";

function directoryForShell(shell: Shell, shimDirectory: string): string {
  if (shell === "pwsh") return shimDirectory;
  const drivePath = /^([A-Za-z]):[\\/](.*)$/.exec(shimDirectory);
  return drivePath ? `/${drivePath[1].toLowerCase()}/${drivePath[2].replace(/\\/g, "/")}` : shimDirectory;
}

export function shellPathProbe(shell: Shell): string {
  switch (shell) {
    case "bash":
    case "zsh":
      return `printf '%s' "$PATH"`;
    case "fish":
      return `string join ':' $PATH`;
    case "pwsh":
      return `[Console]::Out.Write($env:PATH)`;
  }
}

function delimiterFor(shell: Shell): string {
  return shell === "pwsh" ? ";" : ":";
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function verifyShellPaths(shimDirectory: string, readPath: (shell: Shell, probe: string) => string): void {
  for (const shell of ["bash", "zsh", "fish", "pwsh"] as const) {
    const path = readPath(shell, shellPathProbe(shell));
    const firstEntry = path.split(delimiterFor(shell))[0];
    if (!firstEntry || !sameDirectory(firstEntry, directoryForShell(shell, shimDirectory))) {
      throw new Error(`VibeBloat shim is not first on ${shell} PATH.`);
    }
  }
}
