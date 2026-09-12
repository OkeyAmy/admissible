# Admissible — Oracle deployment

Target: Oracle Cloud Always-Free VM (`opc@` Oracle Linux 9), IP from the OCI console.

## One-shot provision

```bash
scp -i vouchsafe/.ssh/oracle_attest deploy/provision.sh opc@<IP>:~/
ssh -i vouchsafe/.ssh/oracle_attest opc@<IP> 'chmod +x ~/provision.sh && ./provision.sh'
```

`provision.sh` is idempotent: installs git/nginx/Node 22/pnpm 11.18.0, clones the repo
to `/opt/admissible`, installs deps, writes systemd units + nginx config, opens the OS
firewall. It does **not** create `/opt/admissible/.env`.

## .env (secret, never committed)

```bash
scp -i vouchsafe/.ssh/oracle_attest vouchsafe/.env opc@<IP>:~/env-staging
ssh -i vouchsafe/.ssh/oracle_attest opc@<IP> 'mv ~/env-staging /opt/admissible/.env && chmod 600 /opt/admissible/.env'
```

The repo `.env` already carries `REGISTRY_ADDRESS` and the funded testnet key. The unit
files load it via `EnvironmentFile`.

## Build the web app (baked-in relayer + registry addresses)

```bash
VITE_REGISTRY_ADDRESS=0xA972422a821F622bcC1a72d0B19242F1ae2C6047 \
VITE_RELAYER_URL=http://<IP> \
pnpm -F web build
```

`VITE_RELAYER_URL` points at the public origin; nginx proxies `/mirror` and `/health`
to the relayer on `:8787`. If HTTPS is added later, rebuild with `https://<host>`.

## Enable + start

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now admissible-worker admissible-relayer nginx admissible-bench.timer
systemctl --no-pager status admissible-worker admissible-relayer admissible-bench.timer
```

| unit | what it is |
|---|---|
| `admissible-worker.service` | daemon — polls EAS on Sepolia+Mainnet, mirrors into Creditcoin |
| `admissible-relayer.service` | daemon — public `POST /mirror` on `:8787`, holds the funded key |
| `admissible-bench.service` | oneshot — one evidence pass |
| `admissible-bench.timer` | runs bench every 30 min |

## Verify

```bash
curl -s http://<IP>/health            # relayer health through nginx
curl -sI http://<IP>/                 # static site
journalctl -u admissible-worker -n 20 --no-pager
tail -c 400 /opt/admissible/receipts/mirrors.jsonl
```

## Oracle Cloud console — security list (cannot be done from the box)

Add ingress rules 0.0.0.0/0 for **TCP 80** and **TCP 443** (TCP 22 is usually already
defaulted). The OS firewall is handled by the provisioner.

## Operational notes

- Worker and bench share the same funded wallet. The bench timer fires at `:00`/`:30`;
  if the worker is mid-submit the two can race nonces. If that ever happens, give bench
  its own funded wallet in `.env` (`BENCH_PRIVATE_KEY` branch) or widen the timer.
- `receipts/mirrors.jsonl` grows forever. Archive/rotate per day and pull new lines
  back into the repo so the committed evidence stays current.
- `worker/state.json` persists across restarts (survives `systemctl restart`).
- HTTPS: point a domain at the IP, then `certbot --nginx` (nginx config already
  has the proxy locations).