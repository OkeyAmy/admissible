#!/usr/bin/env bash
# Admissible — box bring-up (no dnf; runs on the pre-staged /opt/admissible).
set -euo pipefail
APP=/opt/admissible
NODE=$APP/node/bin/node

echo "== node port-80 capability =="
sudo setcap cap_net_bind_service=+ep "$NODE" 2>/dev/null && echo "setcap ok" || echo "setcap unavailable (web unit will run as root)"

echo "== bench runner (node-based, no pnpm) =="
cat > $APP/deploy/run-bench.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd /opt/admissible
export PATH="/opt/admissible/node/bin:/usr/bin:/bin"
export NODE_OPTIONS="--max-old-space-size=256"
LOG=/tmp/admissible-bench.log
echo "[bench] $(date -Is) start" >> "$LOG"
/opt/admissible/bench/node_modules/.bin/tsx bench/src/index.ts >> "$LOG" 2>&1 || true
/opt/admissible/bench/node_modules/.bin/tsx bench/src/summarize.ts >> "$LOG" 2>&1 || true
echo "[bench] $(date -Is) done" >> "$LOG"
EOF
chmod +x $APP/deploy/run-bench.sh

echo "== systemd units =="

sudo tee /etc/systemd/system/admissible-worker.service >/dev/null <<EOF
[Unit]
Description=Admissible mirror worker (Attestcoin Protocol)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=opc
Group=opc
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=PATH=$APP/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=$APP/worker/node_modules/.bin/tsx worker/src/index.ts
Restart=always
RestartSec=15
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/admissible-relayer.service >/dev/null <<EOF
[Unit]
Description=Admissible relayer (public POST /mirror, port 8787)
After=network-online.target

[Service]
Type=simple
User=opc
Group=opc
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=PATH=$APP/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=$APP/relayer/node_modules/.bin/tsx relayer/src/index.ts
Restart=always
RestartSec=10
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/admissible-web.service >/dev/null <<EOF
[Unit]
Description=Admissible static web + /mirror|/health proxy (port 80)
After=network-online.target admissible-relayer.service

[Service]
Type=simple
User=opc
Group=opc
WorkingDirectory=$APP
Environment=PATH=$APP/node/bin:/usr/local/bin:/usr/bin:/bin
Environment=NODE_OPTIONS=--max-old-space-size=128
Environment=WEB_PORT=80
Environment=RELAYER_HOST=127.0.0.1
Environment=RELAYER_PORT=8787
ExecStart=$NODE $APP/deploy/serve-static.mjs
Restart=always
RestartSec=5
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/admissible-bench.service >/dev/null <<EOF
[Unit]
Description=Admissible bench — one evidence pass then summary
After=network-online.target

[Service]
Type=oneshot
User=opc
Group=opc
WorkingDirectory=$APP
ExecStart=$APP/deploy/run-bench.sh
TimeoutStartSec=0
EOF

sudo tee /etc/systemd/system/admissible-bench.timer >/dev/null <<EOF
[Unit]
Description=Run Admissible bench every 30 minutes

[Timer]
OnCalendar=*:0/30
Persistent=true
Unit=admissible-bench.service

[Install]
WantedBy=timers.target
EOF

echo "== firewall (OS) =="
if command -v firewall-cmd >/dev/null 2>&1; then
  sudo firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  sudo firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  sudo firewall-cmd --reload >/dev/null 2>&1 || true
  echo "firewalld: http/https opened"
else
  echo "no firewalld"
fi
if command -v setenforce >/dev/null 2>&1; then getenforce; fi

echo "== daemon-reload + enable =="
sudo systemctl daemon-reload
sudo systemctl enable --now admissible-worker admissible-relayer admissible-web admissible-bench.timer

echo "== status =="
sudo systemctl --no-pager --lines=0 status admissible-worker admissible-relayer admissible-web admissible-bench.timer
echo "BOX_SETUP_DONE"