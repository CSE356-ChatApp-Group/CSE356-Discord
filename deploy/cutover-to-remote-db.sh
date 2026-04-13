#!/usr/bin/env bash
# Cut over production from co-located Postgres to a dedicated DB host.
# Run from a machine that can SSH to BOTH the app VM and the DB VM (VPN/campus as needed).
#
# Prerequisites:
#   - New DB host already has PostgreSQL 16, database chatapp_prod, role chatapp, and
#     /root/chatapp_prod_db_credentials.txt (see prior DB setup).
#   - App VM can reach DB_PRIVATE_IP:5432 (Linode private network + firewall).
#   - Local Postgres on app VM still running with data to migrate.
#
# Usage:
#   APP_SSH=root@130.245.136.44 DB_SSH=root@130.245.136.21 DB_PRIVATE_IP=10.0.1.62 \
#     ./deploy/cutover-to-remote-db.sh
#
set -euo pipefail

APP_SSH="${APP_SSH:-root@130.245.136.44}"
DB_SSH="${DB_SSH:-root@130.245.136.21}"
DB_PRIVATE_IP="${DB_PRIVATE_IP:-10.0.1.62}"
DB_CREDS_REMOTE="${DB_CREDS_REMOTE:-/root/chatapp_prod_db_credentials.txt}"
ENV_FILE="${ENV_FILE:-/opt/chatapp/shared/.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "ERROR: $*" >&2; exit 1; }

echo "=== ChatApp: cutover to remote PostgreSQL ==="
echo "  App SSH:    ${APP_SSH}"
echo "  DB SSH:     ${DB_SSH}"
echo "  DB private: ${DB_PRIVATE_IP}"
echo ""

echo "==> SSH check"
ssh -o BatchMode=yes -o ConnectTimeout=20 "${APP_SSH}" 'hostname' >/dev/null || die "Cannot SSH to app (${APP_SSH})"
ssh -o BatchMode=yes -o ConnectTimeout=20 "${DB_SSH}" 'hostname' >/dev/null || die "Cannot SSH to DB (${DB_SSH})"

echo "==> App -> DB TCP ${DB_PRIVATE_IP}:5432"
if ! ssh "${APP_SSH}" "timeout 4 bash -c 'cat < /dev/null > /dev/tcp/${DB_PRIVATE_IP}/5432'" 2>/dev/null; then
  ssh "${APP_SSH}" "nc -zv -w 5 ${DB_PRIVATE_IP} 5432" || die "App cannot reach ${DB_PRIVATE_IP}:5432 — fix Linode firewall / private networking"
fi

echo "==> Read chatapp password from DB host"
PW="$(ssh "${DB_SSH}" "grep '^CHATAPP_DB_PASSWORD=' '${DB_CREDS_REMOTE}' | cut -d= -f2-")"
[[ -n "${PW}" ]] || die "Empty CHATAPP_DB_PASSWORD on DB host (${DB_CREDS_REMOTE})"

echo "==> Source Postgres on app (must be active)"
ssh "${APP_SSH}" 'systemctl is-active --quiet postgresql' || die "postgresql.service is not active on app — nothing to dump"

USERS="$(ssh "${APP_SSH}" "sudo -u postgres psql -d chatapp_prod -tAc 'SELECT count(*) FROM users'")" || die "Cannot read users count — wrong DB?"
echo "    users row count (sanity): ${USERS}"

BACKUP_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
echo "==> Backup app .env"
ssh "${APP_SSH}" "sudo test -f '${ENV_FILE}'" || die "Missing ${ENV_FILE}"
ssh "${APP_SSH}" "sudo cp -a '${ENV_FILE}' '${ENV_FILE}.bak.cutover.${BACKUP_TAG}'"

echo "==> pg_dump (app) -> psql (remote DB) — may take several minutes"
set +o pipefail
ssh "${APP_SSH}" 'sudo -u postgres pg_dump -d chatapp_prod' | ssh "${DB_SSH}" 'sudo -u postgres psql -d chatapp_prod -v ON_ERROR_STOP=1'
PG_DUMP_STATUS=("${PIPESTATUS[@]}")
set -o pipefail
[[ "${PG_DUMP_STATUS[0]}" -eq 0 ]] || die "pg_dump failed (exit ${PG_DUMP_STATUS[0]})"
[[ "${PG_DUMP_STATUS[1]}" -eq 0 ]] || die "psql restore failed (exit ${PG_DUMP_STATUS[1]})"

echo "==> Role timeouts on DB (superuser)"
ssh "${DB_SSH}" "sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c \"
ALTER ROLE chatapp SET statement_timeout='15s';
ALTER ROLE chatapp SET idle_in_transaction_session_timeout='10s';
\""

echo "==> Update ${ENV_FILE} with direct DATABASE_URL (then PgBouncer will rewrite to :6432)"
scp -q "${SCRIPT_DIR}/cutover-update-env.py" "${APP_SSH}:/tmp/cutover-update-env.py"
ssh "${APP_SSH}" "sudo mv /tmp/cutover-update-env.py /root/cutover-update-env.py"
printf '%s' "${PW}" | ssh "${APP_SSH}" "sudo tee /root/.cutover_pw >/dev/null"
ssh "${APP_SSH}" "sudo chmod 600 /root/.cutover_pw"
ssh "${APP_SSH}" "export DB_PRIVATE_IP='${DB_PRIVATE_IP}' ENV_FILE='${ENV_FILE}' PW_FILE=/root/.cutover_pw; sudo -E python3 /root/cutover-update-env.py; sudo rm -f /root/.cutover_pw /root/cutover-update-env.py"

echo "==> PgBouncer config"
scp -q "${SCRIPT_DIR}/pgbouncer-setup.py" "${APP_SSH}:/tmp/pgbouncer-setup.py"
# Match deploy-prod.sh: cap 400, ncpu*50 (+ multi-instance bump if CHATAPP_INSTANCES set)
PGBOUNCER_POOL_SIZE="${PGBOUNCER_POOL_SIZE:-}"
if [[ -z "${PGBOUNCER_POOL_SIZE}" ]]; then
  N="$(ssh "${APP_SSH}" 'nproc --all')"
  INST="$(ssh "${APP_SSH}" "systemctl list-units --type=service --state=running 'chatapp@*.service' -q 2>/dev/null | wc -l" | tr -d ' ')"
  INST="${INST:-1}"
  [[ "${INST}" =~ ^[0-9]+$ ]] || INST=1
  EXTRA=$(( (INST - 1) * 30 ))
  [[ "${EXTRA}" -lt 0 ]] && EXTRA=0
  PGBOUNCER_POOL_SIZE=$(( N * 50 + EXTRA ))
  [[ "${PGBOUNCER_POOL_SIZE}" -gt 400 ]] && PGBOUNCER_POOL_SIZE=400
  [[ "${PGBOUNCER_POOL_SIZE}" -lt 60 ]] && PGBOUNCER_POOL_SIZE=60
fi
echo "    PGBOUNCER_POOL_SIZE=${PGBOUNCER_POOL_SIZE}"
ssh "${APP_SSH}" "sudo env PGBOUNCER_POOL_SIZE=${PGBOUNCER_POOL_SIZE} python3 /tmp/pgbouncer-setup.py"

echo "==> systemd: stop local Postgres; drop-in so chatapp does not pull postgresql.service"
scp -q "${SCRIPT_DIR}/systemd/chatapp-remote-db.drop-in.conf" "${APP_SSH}:/tmp/remote-db.conf"
ssh "${APP_SSH}" 'sudo mkdir -p /etc/systemd/system/chatapp@.service.d && sudo mv /tmp/remote-db.conf /etc/systemd/system/chatapp@.service.d/remote-db.conf && sudo systemctl daemon-reload'

ssh "${APP_SSH}" 'sudo systemctl disable --now postgresql.service 2>/dev/null || sudo systemctl stop postgresql.service'

echo "==> Restart pgbouncer + chatapp + nginx"
ssh "${APP_SSH}" 'sudo systemctl restart pgbouncer.service && sudo systemctl restart chatapp@4000.service chatapp@4001.service && sudo nginx -t && sudo systemctl reload nginx'

echo "==> Health check"
ssh "${APP_SSH}" 'curl -sS -m 10 -k https://127.0.0.1/health || curl -sS -m 10 http://127.0.0.1/health' | head -c 400 || true
echo ""

echo "=== Cutover finished ==="
echo "  - Old .env backup: ${ENV_FILE}.bak.cutover.${BACKUP_TAG}"
echo "  - Verify: ssh ${APP_SSH} 'curl -sk https://127.0.0.1/health'"
echo "  - Optional: copy monitoring env: sudo cp ${ENV_FILE} /opt/chatapp-monitoring/.env"
echo "  - If something is wrong: restore .env backup and sudo systemctl start postgresql, redeploy pgbouncer from old URL"
