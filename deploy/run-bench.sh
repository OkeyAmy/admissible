#!/usr/bin/env bash
# Admissible — one evidence pass (bench) then regenerate the summary.
# Runs from systemd (admissible-bench.service) and by hand.
set -euo pipefail
cd /opt/admissible

echo "[bench] $(date -Is) start"
pnpm -F bench bench >/tmp/admissible-bench.log 2>&1 || true
pnpm -F bench summary >>/tmp/admissible-bench.log 2>&1 || true
echo "[bench] $(date -Is) done (log: /tmp/admissible-bench.log)"