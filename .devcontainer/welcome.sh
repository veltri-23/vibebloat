#!/usr/bin/env bash
# Vibebloat Codespace welcome message. Runs each time the Codespace starts.
set -euo pipefail

cd "$(dirname "$0")/.."

cat <<'EOF'
=============================================
  Vibebloat — try it here
=============================================

Quick start:

  bun src/cli.ts doctor            # health check
  bun src/cli.ts init --pretty     # walk onboarding (warm prose)

For the model pass, set OPENAI_API_KEY in your Codespace secrets, or:

  curl -fsSL https://ollama.com/install.sh | sh
  ollama pull llama3.1:8b

To wipe: rm -rf ~/.vibebloat ~/fake-claude ~/fake-codex ~/fake-hermes
=============================================
EOF
