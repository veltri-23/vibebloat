#!/usr/bin/env bash
# Vibebloat Codespace setup. Runs once when the Codespace is created.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[vibebloat] installing dependencies"
bun install --frozen-lockfile

echo "[vibebloat] ready"
echo "[vibebloat] run: bun src/cli.ts doctor"
echo "[vibebloat] run: bun src/cli.ts init --pretty"
echo "[vibebloat] or paste: bun src/cli.ts init --pretty  (then walk gates)"
