#!/usr/bin/env bash
# Runs bench continuously: one full pass, regenerate summary.json, repeat.
# bench/src/index.ts exits after a single pass by design; this is what keeps
# it running for "a very long time" per the no-cap instruction.
set -uo pipefail
cd "$(dirname "$0")"
set -a
source ../.env
set +a

while true; do
  echo "[run-loop $(date -Is)] bench pass starting"
  node node_modules/tsx/dist/cli.mjs src/index.ts
  echo "[run-loop $(date -Is)] bench pass done, regenerating summary"
  node node_modules/tsx/dist/cli.mjs src/summarize.ts
  echo "[run-loop $(date -Is)] sleeping 60s before next pass"
  sleep 60
done
