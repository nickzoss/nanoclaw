#!/usr/bin/env bash
# Test the nanoclaw-agent container locally.
# Reads GITHUB_TOKEN and optional COPILOT_MODEL vars from the project .env file so you don't have to pass them manually.
#
# Usage:
#   echo '<json>' | ./test-run.sh
#   ./test-run.sh                      # uses default test payload
#   GITHUB_TOKEN=xxx ./test-run.sh     # override token from env
#   COPILOT_MODEL="gpt-5-mini" COPILOT_MODEL_ARGS="--reasoning=high" ./test-run.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

read_env_key() {
  local key="$1"
  if [ -f "$ENV_FILE" ]; then
    grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true
  fi
}

# Use token from environment if already set, otherwise read from .env
if [ -z "$GITHUB_TOKEN" ] && [ -z "$GH_TOKEN" ] && [ -z "$COPILOT_GITHUB_TOKEN" ]; then
  TOKEN=$(read_env_key 'COPILOT_GITHUB_TOKEN')
  if [ -z "$TOKEN" ]; then TOKEN=$(read_env_key 'GH_TOKEN'); fi
  if [ -z "$TOKEN" ]; then TOKEN=$(read_env_key 'GITHUB_TOKEN'); fi
  if [ -z "$TOKEN" ]; then
    echo "Error: No GitHub token found. Set GITHUB_TOKEN or add it to .env" >&2
    exit 1
  fi
  export GITHUB_TOKEN="$TOKEN"
fi

# COPILOT model defaults: allow override via env or .env, otherwise use safe defaults
if [ -z "$COPILOT_MODEL" ]; then
  M=$(read_env_key 'COPILOT_MODEL')
  if [ -z "$M" ]; then M='gpt-5-mini'; fi
  export COPILOT_MODEL="$M"
fi

if [ -z "$COPILOT_MODEL_ARGS" ]; then
  MA=$(read_env_key 'COPILOT_MODEL_ARGS')
  if [ -z "$MA" ]; then MA=''; fi
  export COPILOT_MODEL_ARGS="$MA"
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
    -e COPILOT_MODEL \
    -e COPILOT_MODEL_ARGS \
    nanoclaw-agent:latest
else
  # Pipe stdin through
  docker run -i \
    -e GITHUB_TOKEN \
    -e GH_TOKEN \
    -e COPILOT_GITHUB_TOKEN \
    -e COPILOT_MODEL \
    -e COPILOT_MODEL_ARGS \
    nanoclaw-agent:latest
fi
