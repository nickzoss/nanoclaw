#!/usr/bin/env bash
# Test the nanoclaw-agent container locally.
# Reads GITHUB_TOKEN from the project .env file so you don't have to pass it manually.
#
# Usage:
#   echo '<json>' | ./test-run.sh
#   ./test-run.sh                      # uses default test payload
#   GITHUB_TOKEN=xxx ./test-run.sh     # override token from env
#
# Example JSON payloads:
#   {"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

# Use token from environment if already set, otherwise read from .env
if [ -z "$GITHUB_TOKEN" ] && [ -z "$GH_TOKEN" ] && [ -z "$COPILOT_GITHUB_TOKEN" ]; then
  if [ -f "$ENV_FILE" ]; then
    TOKEN=$(grep -E '^(COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN)=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  fi
  if [ -z "$TOKEN" ]; then
    echo "Error: No GitHub token found. Set GITHUB_TOKEN or add it to .env" >&2
    exit 1
  fi
  export GITHUB_TOKEN="$TOKEN"
fi

DEFAULT_PAYLOAD='{"prompt":"What is 2+2?","groupFolder":"test","chatJid":"test@g.us","isMain":false}'

if [ -t 0 ]; then
  # No stdin — use default payload
  PAYLOAD="$DEFAULT_PAYLOAD"
  echo "Using default payload: $PAYLOAD"
  echo "$PAYLOAD" | docker run -i \
    -e GITHUB_TOKEN \
    -e GH_TOKEN \
    -e COPILOT_GITHUB_TOKEN \
    nanoclaw-agent:latest
else
  # Pipe stdin through
  docker run -i \
    -e GITHUB_TOKEN \
    -e GH_TOKEN \
    -e COPILOT_GITHUB_TOKEN \
    nanoclaw-agent:latest
fi
