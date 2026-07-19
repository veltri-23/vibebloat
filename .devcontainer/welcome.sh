#!/usr/bin/env bash
# Vibebloat Codespace welcome message. Runs each time the Codespace starts.
set -euo pipefail

cd "$(dirname "$0")/.."

cat <<'EOF'
=============================================
  Vibebloat — try it here
=============================================

Start here. No setup, no API key, about ten seconds:

  bun src/cli.ts demo

That runs the real pipeline over a labelled sample history and shows the
guards it produces blocking the exact commands that caused each incident.
A fresh Codespace has no agent history of its own, so the sample stands in
for yours.

Then, on a machine that does have history:

  bun src/cli.ts init --pretty     # walk onboarding against your own sessions
  bun src/cli.ts doctor            # health check

To mine the sample live instead of using its precomputed findings, set
OPENAI_API_KEY in your Codespace secrets, or install a local model:

  curl -fsSL https://ollama.com/install.sh | sh
  ollama pull llama3.1:8b

To wipe anything Vibebloat wrote: rm -rf ~/.vibebloat
=============================================
EOF
