# deploy/deploy-prod-rolling.sh
# Nginx upstream rewrite, release capture/restore, deploy gates, worker restart, rollback_cutover.
# Sourced by deploy-prod.sh after TARGET_PORTS_CSV and related state are initialized.
# Depends on: ssh_prod, RELEASE_*, CHATAPP_NGINX_SITE_PATH, deploy_log_phase (caller), etc.
# shellcheck shell=bash

csv_has_port() {
  local csv="${1:-}"
  local port="${2:-}"
  case ",${csv}," in
    *",${port},"*) return 0 ;;
    *) return 1 ;;
  esac
}

rewrite_nginx_upstream() {
  local ports_csv="${1:?ports csv required}"
  local context="${2:-upstream rewrite}"
  if [ "${SKIP_INGRESS_POST_DEPLOY:-0}" = "1" ]; then
    echo "Skipping local nginx upstream rewrite (${context}) on worker-only host"
    return 0
  fi
  ssh_prod "
    set -euo pipefail
    export PORTS_CSV='${ports_csv}'
    export SITE='${CHATAPP_NGINX_SITE_PATH}'
    export WS_TIER_ENABLED='${WS_TIER_ENABLED:-false}'
    export EXTRA_UPSTREAM_SERVERS_CSV='${EXTRA_UPSTREAM_SERVERS_CSV:-}'
    export LOCAL_WS_PORTS_CSV='${LOCAL_WS_PORTS_CSV:-${ports_csv}}'
    export WS_EXTRA_UPSTREAM_SERVERS_CSV='${WS_EXTRA_UPSTREAM_SERVERS_CSV:-${EXTRA_UPSTREAM_SERVERS_CSV:-}}'
    TMP_SITE=\$(mktemp)
    sudo cp \"\$SITE\" \"\$TMP_SITE\"
    export TMP_SITE
    python3 <<'PY'
import os
import re

cfg_path = os.environ['TMP_SITE']
ports = [p.strip() for p in os.environ['PORTS_CSV'].split(',') if p.strip()]
if not ports:
    raise SystemExit('no upstream ports provided')
local_ws_ports_csv = os.environ.get('LOCAL_WS_PORTS_CSV', '').strip()
if local_ws_ports_csv == '__none__':
    local_ws_ports = []
else:
    local_ws_ports = [p.strip() for p in local_ws_ports_csv.split(',') if p.strip()]

# Keepalive tuning for throughput: larger pools and longer reuse reduce upstream
# TCP churn and handshake overhead during sustained high request rates.
# Nginx has no explicit round_robin keyword; default multi-upstream scheduling is round-robin.
keepalive = '''  keepalive 256;
  keepalive_requests 10000;
  keepalive_timeout 75s;
'''
dollar = chr(36)
map_block = (
    f'map {dollar}arg_token {dollar}ws_sticky_key ' + '{\\n'
    + '  default ' + f'{dollar}arg_token;\\n'
    + '  ""      ' + f'{dollar}binary_remote_addr;\\n'
    + '}\\n\\n'
)
if len(ports) == 1:
    servers = f'  server localhost:{ports[0]} max_fails=0;\\n'
    balance = ''
else:
    servers = ''.join(
        f'  server localhost:{port} max_fails=0;\\n'
        for port in ports
    )
    balance = ''

# Preserve extra upstream servers (e.g. VM2 in multi-VM mode) on every rewrite.
extra_csv = os.environ.get('EXTRA_UPSTREAM_SERVERS_CSV', '').strip()
if extra_csv:
    for ep in extra_csv.split(','):
        ep = ep.strip()
        if ep:
            servers += f'  server {ep} max_fails=0;\\n'

http_block = (
    'upstream app {\\n'
    + balance
    + servers
    + keepalive
    + '}'
)

ws_servers = ''.join(f'  server localhost:{port} max_fails=0;\\n' for port in local_ws_ports)
ws_extra_csv = os.environ.get('WS_EXTRA_UPSTREAM_SERVERS_CSV', '').strip()
if ws_extra_csv:
    for ep in ws_extra_csv.split(','):
        ep = ep.strip()
        if ep:
            ws_servers += f'  server {ep} max_fails=0;\\n'
if not ws_servers:
    raise SystemExit('no websocket upstream servers provided')

ws_block = (
    'upstream app_ws {\\n'
    + f'  hash {dollar}ws_sticky_key consistent;\\n'
    + ws_servers
    + keepalive
    + '}'
)

text = open(cfg_path).read()
if 'ws_sticky_key' not in text:
    text, n_map = re.subn(r'(^\\s*upstream app \\{)', map_block + r'\\1', text, count=1, flags=re.MULTILINE)
    if n_map != 1:
        raise SystemExit('ws_sticky_key map missing and bootstrap insert failed (n=%d)' % n_map)
text, n = re.subn(r'upstream app \\{[^}]+\\}', http_block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('upstream app block not replaced (n=%d)' % n)
text, n_ws = re.subn(r'upstream app_ws \\{[^}]+\\}', ws_block, text, count=1, flags=re.DOTALL)
if n_ws == 0:
    text, n_insert = re.subn(r'(upstream app \\{[^}]+\\}\\n+)', r'\\1' + ws_block + '\\n', text, count=1, flags=re.DOTALL)
    if n_insert != 1:
        raise SystemExit('upstream app_ws block missing and bootstrap insert failed (n=%d)' % n_insert)
elif n_ws != 1:
    raise SystemExit('upstream app_ws block not replaced (n=%d)' % n_ws)
open(cfg_path, 'w').write(text)
PY
    sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
    rm -f \"\$TMP_SITE\"
    sudo nginx -t >/dev/null
    sudo systemctl reload nginx
  " || {
    echo "ERROR: ${context} failed."
    return 1
  }
}

nginx_drain_after_upstream_removal() {
  local context="${1:-before worker restart}"
  local drain_secs="${NGINX_RELOAD_DRAIN_SECS:-20}"

  if [ "${SKIP_INGRESS_POST_DEPLOY:-0}" = "1" ]; then
    return 0
  fi
  if ! [[ "${drain_secs}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: NGINX_RELOAD_DRAIN_SECS must be an integer (got '${drain_secs}')"
    return 1
  fi
  if [ "${drain_secs}" -le 0 ]; then
    echo "  Nginx drain disabled (${context})"
    return 0
  fi

  echo "  Draining nginx old workers ${drain_secs}s (${context})..."
  sleep "${drain_secs}"
}

stop_chatapp_port() {
  local p="${1:?port required}"
  ssh_prod "sudo systemctl stop chatapp@${p} 2>/dev/null || true"
}

capture_previous_release_map() {
  PREV_RELEASE_MAP=()
  PREV_ACTIVE_PORTS=()
  for p in "${TARGET_PORTS[@]}"; do
    local release_path
    release_path="$(ssh_prod "
      set -euo pipefail
      if ! systemctl is-active --quiet chatapp@${p}; then
        exit 0
      fi
      pid=\$(systemctl show -p MainPID --value chatapp@${p} || true)
      if [ -z \"\${pid}\" ] || [ \"\${pid}\" = \"0\" ]; then
        exit 0
      fi
      cwd=\$(readlink -f /proc/\${pid}/cwd 2>/dev/null || true)
      if [ -z \"\${cwd}\" ]; then
        exit 0
      fi
      case \"\${cwd}\" in
        */backend) echo \"\${cwd%/backend}\" ;;
        *) echo \"\${cwd}\" ;;
      esac
    " || true)"
    if [ -n "${release_path}" ]; then
      PREV_RELEASE_MAP+=( "${p}:${release_path}" )
      PREV_ACTIVE_PORTS+=( "${p}" )
    fi
  done
  PREV_ACTIVE_PORTS_CSV=$(IFS=,; echo "${PREV_ACTIVE_PORTS[*]:-}")
  if [ "${#PREV_RELEASE_MAP[@]}" -gt 0 ]; then
    echo "Captured previous worker release map: ${PREV_RELEASE_MAP[*]}"
  else
    echo "WARN: previous worker release map is empty (fresh host or inactive units)"
  fi
}

restore_previous_release_map() {
  if [ "${#PREV_RELEASE_MAP[@]}" -eq 0 ]; then
    echo "↩ No previous release map captured; skipping worker release restoration."
    return 0
  fi
  echo "↩ Restoring prior worker release map..."
  for entry in "${PREV_RELEASE_MAP[@]}"; do
    local port="${entry%%:*}"
    local release_path="${entry#*:}"
    ssh_prod "
      set -euo pipefail
      DROPIN_DIR=/etc/systemd/system/chatapp@${port}.service.d
      sudo mkdir -p \"\$DROPIN_DIR\"
      printf '[Service]\nWorkingDirectory=%s/backend\n' '${release_path}' | sudo tee \"\$DROPIN_DIR/release.conf\" >/dev/null
      sudo systemctl daemon-reload
      sudo systemctl restart chatapp@${port}
      /tmp/health-check.sh ${port} http://127.0.0.1:${port} >/dev/null
    " || {
      echo "WARN: could not fully restore chatapp@${port} to ${release_path}"
    }
  done
}

restore_previous_upstream_topology() {
  local ports_csv="${PREV_ACTIVE_PORTS_CSV:-}"
  if [ -z "${ports_csv}" ]; then
    ports_csv="${OLD_PORT}"
  fi
  echo "↩ Restoring nginx upstream topology to ports: ${ports_csv}"
  rewrite_nginx_upstream "${ports_csv}" "restore previous nginx upstream topology"
}

reclaim_spare_candidate_on_rollback() {
  if csv_has_port "${PREV_ACTIVE_PORTS_CSV}" "${NEW_PORT}"; then
    return 0
  fi
  echo "↩ Reclaiming candidate port ${NEW_PORT} during rollback..."
  ssh_prod "
    sudo systemctl stop chatapp@${NEW_PORT} 2>/dev/null || true
    sudo systemctl disable chatapp@${NEW_PORT} 2>/dev/null || true
  " >/dev/null 2>&1 || true
}

gate_same_release() {
  echo "Gate: same-release parity across target workers..."
  local expected="${RELEASE_DIR}/${RELEASE_SHA}/backend"
  # After `systemctl restart`, MainPID and /proc/$pid/cwd can lag briefly; retry
  # instead of failing an otherwise-successful rolling deploy.
  local attempt max_attempts
  max_attempts="${SAME_RELEASE_GATE_MAX_ATTEMPTS:-8}"
  attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    if ssh_prod "
    set -euo pipefail
    expected='${expected}'
    for p in ${TARGET_PORTS_CSV//,/ }; do
      systemctl is-active --quiet chatapp@\${p} || { echo \"inactive chatapp@\${p}\"; exit 1; }
      pid=\$(systemctl show -p MainPID --value chatapp@\${p})
      [ -n \"\${pid}\" ] && [ \"\${pid}\" != \"0\" ] || { echo \"missing pid chatapp@\${p}\"; exit 1; }
      cwd=\$(readlink -f /proc/\${pid}/cwd 2>/dev/null || true)
      [ \"\${cwd}\" = \"\${expected}\" ] || { echo \"release mismatch chatapp@\${p}: \${cwd} != \${expected}\"; exit 1; }
      drop=/etc/systemd/system/chatapp@\${p}.service.d/release.conf
      if [ -f \"\${drop}\" ]; then
        line=\$(grep '^WorkingDirectory=' \"\${drop}\" | head -1)
        want=\"WorkingDirectory=\${expected}\"
        [ \"\${line}\" = \"\${want}\" ] || { echo \"systemd drop-in mismatch chatapp@\${p}: \${line} (want \${want})\"; exit 1; }
      fi
    done
  "; then
      echo "✓ Same-release parity gate passed"
      return 0
    fi
    echo "WARN: same-release parity attempt ${attempt}/${max_attempts} failed; sleeping 2s (MainPID/cwd settle)..."
    sleep 2
    attempt=$((attempt + 1))
  done
  echo "ERROR: same-release parity gate failed after ${max_attempts} attempts."
  return 1
}

gate_current_symlink_ok() {
  echo "Gate: /opt/chatapp/current points at this release..."
  local exp="${RELEASE_DIR}/${RELEASE_SHA}"
  if ! ssh_prod "
    set -euo pipefail
    exp='${exp}'
    cur=\$(readlink -f /opt/chatapp/current 2>/dev/null || true)
    [ -n \"\${cur}\" ] || { echo 'missing /opt/chatapp/current'; exit 1; }
    [ \"\${cur}\" = \"\${exp}\" ] || { echo \"current symlink mismatch: \${cur} != \${exp}\"; exit 1; }
  "; then
    echo "ERROR: current symlink gate failed."
    return 1
  fi
  echo "✓ Current symlink gate passed"
}

gate_ingress_post_deploy() {
  if [ "${SKIP_INGRESS_POST_DEPLOY:-0}" = "1" ]; then
    echo "Gate: ingress /health burst skipped (SKIP_INGRESS_POST_DEPLOY=1 — worker-only host, no local nginx :80)"
    return 0
  fi
  local secs="${INGRESS_POST_DEPLOY_SECONDS:-20}"
  echo "Gate: ingress /health burst (${secs}s via nginx :80)..."
  if ! ssh_prod "
    set -euo pipefail
    total='${secs}'
    [ \"\${total}\" -gt 0 ] || exit 0
    for _i in \$(seq 1 \"\${total}\"); do
      curl -fsS -m 4 http://127.0.0.1/health >/dev/null || exit 1
      sleep 1
    done
  "; then
    echo "ERROR: ingress post-deploy health burst failed."
    return 1
  fi
  echo "✓ Ingress post-deploy health burst passed"
}

gate_all_worker_health() {
  echo "Gate: all-worker health (${ALL_WORKER_HEALTH_PASSES} consecutive passes per port)..."
  if ! ssh_prod "
    set -euo pipefail
    passes='${ALL_WORKER_HEALTH_PASSES}'
    for p in ${TARGET_PORTS_CSV//,/ }; do
      ok=0
      for _i in \$(seq 1 \"\${passes}\"); do
        if /tmp/health-check.sh \${p} http://127.0.0.1:\${p} >/dev/null 2>&1; then
          ok=\$((ok+1))
        else
          ok=0
        fi
        sleep 1
      done
      [ \"\${ok}\" -ge \"\${passes}\" ] || { echo \"health gate failed on :\${p}\"; exit 1; }
    done
  "; then
    echo "ERROR: all-worker health gate failed."
    return 1
  fi
  echo "✓ All-worker health gate passed"
}

gate_upstream_parity() {
  if [ "${SKIP_UPSTREAM_PARITY_CHECK:-0}" = "1" ]; then
    echo "Gate: upstream parity skipped (SKIP_UPSTREAM_PARITY_CHECK=1 — multi-VM mode)"
    return 0
  fi
  echo "Gate: nginx upstream parity with active workers..."
  if ! ssh_prod "
    set -euo pipefail
    cfg=/etc/nginx/sites-available/chatapp
    ws_tier_enabled='${WS_TIER_ENABLED:-false}'
    [ -f \"\${cfg}\" ] || { echo 'missing nginx site config'; exit 1; }
    upstream=\$(sudo sed -n '/^upstream app {/,/^}/p' \"\${cfg}\")
    ports_up=\$(echo \"\${upstream}\" | grep -oE 'localhost:[0-9]+|127\\.0\\.0\\.1:[0-9]+' | sed 's/.*://' | sort -u)
    [ -n \"\${ports_up}\" ] || { echo 'no upstream ports'; exit 1; }
    ws_upstream=\$(sudo sed -n '/^upstream app_ws {/,/^}/p' \"\${cfg}\")
    ws_ports_up=\$(echo \"\${ws_upstream}\" | grep -oE 'localhost:[0-9]+|127\\.0\\.0\\.1:[0-9]+' | sed 's/.*://' | sort -u)
    if [ \"\${ws_tier_enabled}\" != \"true\" ]; then
      [ -n \"\${ws_ports_up}\" ] || { echo 'no websocket upstream ports'; exit 1; }
    fi
    active_ports=\$(for p in \$(seq 4000 4007); do systemctl is-active --quiet chatapp@\${p} 2>/dev/null && echo \${p} || true; done | sort -u)
    [ -n \"\${active_ports}\" ] || { echo 'no active chatapp workers'; exit 1; }
    for p in ${TARGET_PORTS_CSV//,/ }; do
      systemctl is-active --quiet chatapp@\${p} || { echo \"inactive chatapp@\${p}\"; exit 1; }
      echo \"\${ports_up}\" | grep -qx \"\${p}\" || { echo \"upstream missing :\${p}\"; exit 1; }
      if [ \"\${ws_tier_enabled}\" != \"true\" ]; then
        echo \"\${ws_ports_up}\" | grep -qx \"\${p}\" || { echo \"ws upstream missing :\${p}\"; exit 1; }
      fi
      echo \"\${active_ports}\" | grep -qx \"\${p}\" || { echo \"unexpected inactive target :\${p}\"; exit 1; }
    done
    for p in \${ports_up}; do
      case ',${TARGET_PORTS_CSV},' in
        *,\${p},*) ;;
        *) echo \"unexpected upstream port :\${p}\"; exit 1 ;;
      esac
    done
    for p in \${active_ports}; do
      case ',${TARGET_PORTS_CSV},' in
        *,\${p},*) ;;
        *) echo \"unexpected active worker :\${p}\"; exit 1 ;;
      esac
    done
    sudo nginx -t >/dev/null
  "; then
    echo "ERROR: upstream parity gate failed."
    return 1
  fi
  echo "✓ Upstream parity gate passed"
}

gate_ingress_canary() {
  echo "Gate: ingress canary (${INGRESS_CANARY_SECONDS}s on nginx path)..."
  if ! ssh_prod "
    set -euo pipefail
    total='${INGRESS_CANARY_SECONDS}'
    [ \"\${total}\" -gt 0 ] || exit 0
    for _i in \$(seq 1 \"\${total}\"); do
      curl -fsS -m 3 http://127.0.0.1/health >/dev/null || exit 1
      sleep 1
    done
  "; then
    echo "ERROR: ingress canary gate failed."
    return 1
  fi
  echo "✓ Ingress canary gate passed"
}

restart_worker_on_release() {
  # Shared worker restart primitive used by both rolling and companion paths.
  # Keeps deploy behavior consistent and easier for operators/agents to edit in one place.
  local port="$1"
  ssh_prod "
    set -euo pipefail
    RELEASE_PATH=${RELEASE_DIR}/${RELEASE_SHA}
    DROPIN_DIR=/etc/systemd/system/chatapp@${port}.service.d
    sudo mkdir -p \"\$DROPIN_DIR\"
    printf '[Service]\\nWorkingDirectory=%s/backend\\n' \"\$RELEASE_PATH\" | sudo tee \"\${DROPIN_DIR}/release.conf\" > /dev/null
    sudo systemctl daemon-reload
    sudo systemctl reset-failed chatapp@${port} 2>/dev/null || true
    ok=0
    for attempt in 1 2 3; do
      sudo systemctl stop chatapp@${port} 2>/dev/null || true
      # Defensive: terminate any remaining processes in the cgroup so the next start
      # cannot race into EADDRINUSE with a stale listener.
      sudo systemctl kill --kill-who=all --signal=TERM chatapp@${port} 2>/dev/null || true
      sleep 0.5
      released=0
      for _ in \$(seq 1 24); do
        if ! sudo ss -H -ltn \"sport = :${port}\" | grep -q .; then
          released=1
          break
        fi
        sleep 0.5
      done
      if [ \"\$released\" -ne 1 ]; then
        # Escalate to SIGKILL for stale listeners still occupying the port.
        for pid in \$(sudo ss -H -ltnp \"sport = :${port}\" | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | sort -u); do
          sudo kill -TERM \"\$pid\" 2>/dev/null || true
        done
        sleep 0.5
        for pid in \$(sudo ss -H -ltnp \"sport = :${port}\" | sed -n 's/.*pid=\\([0-9]\\+\\).*/\\1/p' | sort -u); do
          sudo kill -9 \"\$pid\" 2>/dev/null || true
        done
        sleep 1
      fi
      sudo systemctl reset-failed chatapp@${port} 2>/dev/null || true
      sudo systemctl start chatapp@${port}
      sleep 2
      if systemctl is-active --quiet chatapp@${port}; then
        ok=1
        break
      fi
      echo \"chatapp@${port} restart attempt \$attempt failed; retrying in 3s\"
      sleep 3
    done
    if [ \"\$ok\" -ne 1 ]; then
      echo 'ERROR: chatapp@${port} failed to become active after retries'
      sudo journalctl -u chatapp@${port} --no-pager -n 60 || true
      exit 1
    fi
    echo 'chatapp@${port} restarted on ${RELEASE_SHA}'
  "
}
rollback_cutover() {
  restore_previous_release_map || true
  restore_previous_upstream_topology || true
  reclaim_spare_candidate_on_rollback || true
  # shellcheck disable=SC2034 # deploy-prod.sh reads after rollback_cutover (trap/cleanup)
  NGINX_CANDIDATE_PIN_ACTIVE=0
}
