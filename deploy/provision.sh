#!/usr/bin/env bash
# Admissible — Oracle Linux 9 provisioner. Idempotent; safe to re-run.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

echo "== packages =="
sudo dnf install -y -q git nginx curl

if ! command -v node >/dev/null 2>&1; then
  echo "== node 22 (NodeSource) =="
  curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - >/dev/null
  sudo dnf install -y -q nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "== pnpm 11.18.0 =="
  sudo npm install -g pnpm@11.18.0 >/dev/null
fi

PNPM_BIN="$(command -v pnpm)"
NODE_BIN="$(command -v node)"
echo "node: $("$NODE_BIN" -v)  pnpm: $("$PNPM_BIN" -v)  bin: $PNPM_BIN"

echo "== app checkout =="
sudo mkdir -p /opt/admissible
sudo chown opc:opc /opt/admissible
if [ ! -d /opt/admissible/.git ]; then
  git clone --depth 1 https://github.com/OkeyAmy/admissible.git /opt/admissible
else
  git -C /opt/admissible pull --ff-only origin main
fi
mkdir -p /opt/admissible/deploy /opt/admissible/receipts

echo "== dependencies =="
cd /opt/admissible
pnpm install --frozen-lockfile

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
WorkingDirectory=/opt/admissible
EnvironmentFile=/opt/admissible/.env
ExecStart=${PNPM_BIN} -F worker start
Restart=always
RestartSec=15
TimeoutStopSec=30
KillSignal=SIGTERM
# grows as polls accumulate; trim if logs become noisy
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/admissible-relayer.service >/dev/null <<EOF
[Unit]
Description=Admissible relayer (public /mirror, port 8787)
After=network-online.target admissible-worker.service
Wants=network-online.target

[Service]
Type=simple
User=opc
Group=opc
WorkingDirectory=/opt/admissible
EnvironmentFile=/opt/admissible/.env
ExecStart=${PNPM_BIN} -F relayer start
Restart=always
RestartSec=10
TimeoutStopSec=30

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
WorkingDirectory=/opt/admissible
ExecStart=/opt/admissible/deploy/run-bench.sh
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

echo "== nginx =="
sudo tee /etc/nginx/conf.d/admissible.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    root /opt/admissible/web/dist;
    index index.html;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location = /health {
        proxy_pass http://127.0.0.1:8787/health;
        proxy_set_header Host $host;
    }

    location = /mirror {
        proxy_pass http://127.0.0.1:8787/mirror;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;
        client_max_body_size 512k;
    }
}
EOF
sudo rm -f /etc/nginx/conf.d/default.conf
sudo nginx -t

echo "== firewall (OS) =="
sudo firewall-cmd --permanent --add-service=http 2>/dev/null || true
sudo firewall-cmd --permanent --add-service=https 2>/dev/null || true
sudo firewall-cmd --reload 2>/dev/null || true

echo "PROVISIONED"
echo "Next: place /opt/admissible/.env, then:"
echo "  sudo systemctl daemon-reload --no-pager"
echo "  sudo systemctl enable --now admissible-worker admissible-relayer nginx admissible-bench.timer"