#!/usr/bin/env bash
# Install prometheus-node-exporter + postgres_exporter on the dedicated PostgreSQL VM
# so the app VM's Prometheus (Grafana stack) can scrape DB host + Postgres metrics.
#
# Prerequisites: PostgreSQL listening on 127.0.0.1:5432, credentials file from DB setup.
#
# Usage:
#   DB_SSH=root@130.245.136.21 ./deploy/install-db-metrics-exporters.sh
#
# Firewall: allow TCP 9100 and 9187 only from the app VM's private IP (Linode / VPC).
#
set -euo pipefail

DB_SSH="${DB_SSH:?Set DB_SSH, e.g. root@130.245.136.21}"
CREDS_REMOTE="${CREDS_REMOTE:-/root/chatapp_prod_db_credentials.txt}"
POSTGRES_EXPORTER_VERSION="${POSTGRES_EXPORTER_VERSION:-v0.15.1}"

echo "=== DB metrics exporters → ${DB_SSH} ==="

ssh -o BatchMode=yes -o ConnectTimeout=25 "${DB_SSH}" bash -s <<REMOTE
set -euo pipefail
CREDS_REMOTE='${CREDS_REMOTE}'
PE_VER='${POSTGRES_EXPORTER_VERSION}'

if [[ ! -f "\${CREDS_REMOTE}" ]]; then
  echo "ERROR: Missing \${CREDS_REMOTE}"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y prometheus-node-exporter
systemctl enable prometheus-node-exporter
systemctl restart prometheus-node-exporter
systemctl is-active --quiet prometheus-node-exporter

ARCH=\$(uname -m)
case "\${ARCH}" in
  x86_64) PE_ARCH=amd64 ;;
  aarch64) PE_ARCH=arm64 ;;
  *) echo "ERROR: Unsupported arch \${ARCH}"; exit 1 ;;
esac
TMP=\$(mktemp -d)
trap 'rm -rf "\${TMP}"' EXIT
curl -fsSL -o "\${TMP}/pe.tgz" \\
  "https://github.com/prometheus-community/postgres_exporter/releases/download/\${PE_VER}/postgres_exporter-\${PE_VER#v}.linux-\${PE_ARCH}.tar.gz"
tar -xzf "\${TMP}/pe.tgz" -C "\${TMP}"
PE_BIN=\$(find "\${TMP}" -name postgres_exporter -type f | head -1)
[[ -n "\${PE_BIN}" ]] || { echo "ERROR: postgres_exporter binary not in archive"; exit 1; }
install -m 0755 "\${PE_BIN}" /usr/local/bin/postgres_exporter

python3 <<PY
import re
import shlex
from pathlib import Path

creds_path = Path("${CREDS_REMOTE}")
text = creds_path.read_text(encoding="utf-8", errors="replace")
pw = None
for line in text.splitlines():
    m = re.match(r"^CHATAPP_DB_PASSWORD=(.*)$", line.strip())
    if m:
        pw = m.group(1).strip().strip('"').strip("'")
        break
if not pw:
    raise SystemExit("ERROR: CHATAPP_DB_PASSWORD not found in credentials file")

from urllib.parse import quote

u = quote("chatapp", safe="")
p = quote(pw, safe="")
dsn = f"postgresql://{u}:{p}@127.0.0.1:5432/chatapp_prod?sslmode=disable"
out = Path("/etc/default/postgres_exporter")
out.write_text("DATA_SOURCE_NAME=" + shlex.quote(dsn) + "\n", encoding="utf-8")
out.chmod(0o600)
print("Wrote /etc/default/postgres_exporter")
PY

cat >/etc/systemd/system/postgres_exporter.service <<'UNIT'
[Unit]
Description=Prometheus PostgreSQL exporter
After=network.target postgresql.service

[Service]
Type=simple
User=nobody
EnvironmentFile=/etc/default/postgres_exporter
ExecStart=/usr/local/bin/postgres_exporter --web.listen-address=:9187
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable postgres_exporter
systemctl restart postgres_exporter
sleep 1
systemctl is-active --quiet postgres_exporter

echo "node_exporter :9100 + postgres_exporter :9187 — active"
ss -tlnp | grep -E ':9100|:9187' || true
REMOTE

echo "Done. Redeploy the app (or run deploy/prometheus-db-file-sd.py on the app VM + restart Prometheus) so scrapes include this host."
