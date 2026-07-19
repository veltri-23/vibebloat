#!/usr/bin/env bash
# Vibebloat Codespace setup. Runs once when the Codespace is created.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v bun >/dev/null 2>&1; then
  echo "[vibebloat] installing bun 1.3.14"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export PATH="$HOME/.bun/bin:$PATH"
fi

echo "[vibebloat] installing dependencies"
bun install --frozen-lockfile

echo "[vibebloat] ready"
echo "[vibebloat] run: bun src/cli.ts doctor"
echo "[vibebloat] run: bun src/cli.ts init --pretty"
