# deploy/deploy-prod-phases.sh
# Extracted high-level deploy phases for deploy-prod.sh.
# shellcheck shell=bash

deploy_prod_run_nginx_cutover_and_worker_roll() {
  # 8c. Nginx access.log: append request_time + upstream_response_time (idempotent).
  echo "8c. Nginx access log timing fields (idempotent)..."
  chatapp_scp_to_prod "${SCRIPT_DIR}/nginx/patches/patch-nginx-access-log-timing.sh" "${PROD_USER}@${PROD_HOST}:/tmp/patch-nginx-access-log-timing.sh"
  ssh_prod 'sudo bash /tmp/patch-nginx-access-log-timing.sh && sudo rm -f /tmp/patch-nginx-access-log-timing.sh'
  echo "✓ Nginx access log timing patch applied"

  # 9. Nginx + kernel tuning / cutover
  # Dual-worker (CHATAPP_INSTANCES>=2): keep both upstreams while candidate warms up, then step 9a
  # pins traffic to NEW_PORT only before the companion stop/restart (9b) so nginx never targets a
  # socket that is down mid-roll. Step 9c restores least_conn across both ports. Requires migrations
  # and API to be backward-compatible between old and new for the shared-traffic window before 9a.
  # Single-worker: point nginx at NEW_PORT only, then tune (original behavior).
  if [ "${CHATAPP_INSTANCES}" -ge 2 ]; then
    echo "9. Dual-worker: nginx/kernel tuning only (upstream unchanged — both ports stay live)..."
    ssh_prod "
      set -euo pipefail
      export SITE='${CHATAPP_NGINX_SITE_PATH}'
      TMP_SITE=\$(mktemp)
      sudo cp \"\$SITE\" \"\$TMP_SITE\"
      sudo sed -i 's/listen 80 default_server;/listen 80 default_server backlog=4096;/g' \"\$TMP_SITE\"
      sudo sed -i 's/listen \\[::\\]:80 default_server;/listen [::]:80 default_server backlog=4096;/g' \"\$TMP_SITE\"
      sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
      rm -f \"\$TMP_SITE\"
      sudo sysctl -w net.ipv4.tcp_max_syn_backlog=${NGINX_WORKER_CONNECTIONS} >/dev/null
      sudo sysctl -w net.core.somaxconn=${NGINX_WORKER_CONNECTIONS} >/dev/null
      TMP_MAIN=\$(mktemp)
      sudo cp /etc/nginx/nginx.conf \"\$TMP_MAIN\"
      sudo sed -i 's/worker_connections [0-9]*/worker_connections ${NGINX_WORKER_CONNECTIONS}/' \"\$TMP_MAIN\"
      sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' \"\$TMP_MAIN\"
      sudo grep -q '^worker_shutdown_timeout' \"\$TMP_MAIN\" \
        || sudo sed -i '/^worker_processes/a worker_shutdown_timeout 20s;' \"\$TMP_MAIN\"
      sudo grep -q 'worker_rlimit_nofile' \"\$TMP_MAIN\" \
        || sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' \"\$TMP_MAIN\"
      sudo install -m 644 \"\$TMP_MAIN\" /etc/nginx/nginx.conf
      rm -f \"\$TMP_MAIN\"
      sudo nginx -t && sudo systemctl reload nginx
      echo 'Nginx: still load-balanced; candidate on '${NEW_PORT}' shares traffic with '${OLD_PORT}''
    "
    echo "✓ Nginx tuned (dual upstream preserved)"
  else
    # Rewrite the whole `upstream app { ... }` block instead of globally s/OLD/NEW/g, which
    # collapses dual server lines into duplicate ports (no load balancing + capacity loss).
    echo "9. Switching Nginx to candidate (single-upstream cutover)..."
    ssh_prod "
      set -euo pipefail
      export NEW_PORT='${NEW_PORT}'
      export OLD_PORT='${OLD_PORT}'
      export SITE='${CHATAPP_NGINX_SITE_PATH}'
      TMP_SITE=\$(mktemp)
      sudo cp \"\$SITE\" \"\$TMP_SITE\"
      export TMP_SITE
      python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
newp = os.environ['NEW_PORT']
keepalive = '''  keepalive 16;
  keepalive_requests 100;
  keepalive_timeout 10s;
'''
block = (
    'upstream app {\\n'
    '  server localhost:%s max_fails=0;\\n' % newp
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('step 9: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
      sudo sed -i 's/listen 80 default_server;/listen 80 default_server backlog=4096;/g' \"\$TMP_SITE\"
      sudo sed -i 's/listen \\[::\\]:80 default_server;/listen [::]:80 default_server backlog=4096;/g' \"\$TMP_SITE\"
      sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
      rm -f \"\$TMP_SITE\"
      sudo nginx -t >/dev/null
      sudo systemctl reload nginx
      sudo sysctl -w net.ipv4.tcp_max_syn_backlog=${NGINX_WORKER_CONNECTIONS} >/dev/null
      sudo sysctl -w net.core.somaxconn=${NGINX_WORKER_CONNECTIONS} >/dev/null
      TMP_MAIN=\$(mktemp)
      sudo cp /etc/nginx/nginx.conf \"\$TMP_MAIN\"
      sudo sed -i 's/worker_connections [0-9]*/worker_connections ${NGINX_WORKER_CONNECTIONS}/' \"\$TMP_MAIN\"
      sudo sed -i 's/#[[:space:]]*multi_accept on/multi_accept on/' \"\$TMP_MAIN\"
      sudo grep -q '^worker_shutdown_timeout' \"\$TMP_MAIN\" \
        || sudo sed -i '/^worker_processes/a worker_shutdown_timeout 20s;' \"\$TMP_MAIN\"
      sudo grep -q 'worker_rlimit_nofile' \"\$TMP_MAIN\" \
        || sudo sed -i '/^worker_processes/a worker_rlimit_nofile 65535;' \"\$TMP_MAIN\"
      sudo install -m 644 \"\$TMP_MAIN\" /etc/nginx/nginx.conf
      rm -f \"\$TMP_MAIN\"
      sudo nginx -t && sudo systemctl reload nginx
      echo 'Nginx: traffic -> candidate port '${NEW_PORT}' only'
    "
    echo "✓ Nginx cutover applied"
  fi

  # 9.05 Idempotent: longer read timeout for search only (general /api/ stays 30s).
  # Prevents nginx from returning 502 while Node is still working on a successful search.
  echo "9.05 Nginx: ensure /api/v1/search extended proxy timeouts..."
  patch_nginx_search_location
  echo "✓ Nginx search route OK"

  # 9.06 Idempotent: add upstream retry policy for /api/ only (exclude websocket path).
  echo "9.06 Nginx: ensure /api/ upstream retry policy..."
  patch_nginx_api_retry
  echo "✓ Nginx /api retry policy OK"

  # 9.07 Idempotent: dedicated /api/v1/auth/ with longer proxy timeouts than generic /api/ (30s).
  # Auth is bcrypt-bound; without this, login/register can see nginx 504 HTML under burst.
  echo "9.07 Nginx: ensure /api/v1/auth/ extended proxy timeouts..."
  patch_nginx_auth_location
  echo "✓ Nginx auth route OK"

  # 9.071 Idempotent: critical OAuth/auth flow routes must bypass strict generic auth
  # throttles so start + callback redirects are not dropped by nginx before the app.
  echo "9.071 Nginx: ensure critical OAuth/auth flow routes bypass strict auth rate limits..."
  patch_nginx_auth_flow_routes
  echo "✓ Nginx critical auth routes OK"

  # 9.075 Idempotent: fix auth block — `non_idempotent` must be on proxy_next_upstream,
  # and remove invalid standalone proxy_next_upstream_non_idempotent if present.
  echo "9.075 Nginx: ensure auth proxy_next_upstream includes non_idempotent..."
  patch_nginx_auth_non_idempotent
  echo "✓ Nginx auth POST retry OK"

  # 9.076 Idempotent: localhost stub_status for nginx-prometheus-exporter (remote-compose edge profile).
  echo "9.076 Nginx: ensure localhost stub_status (:18080) for edge metrics..."
  patch_nginx_stub_status
  echo "✓ Nginx stub_status for exporter OK"

  # 9b–9c. Multi-worker: roll all workers to this release, then verify parity.
  if [ "${CHATAPP_INSTANCES}" -ge 2 ]; then
    if [ "${ROLLING_RESTART:-false}" = "true" ]; then
      # ---- Rolling restart (CHATAPP_INSTANCES >= 3) ----
      # NEW_PORT was already rolled in step 6 and re-added to nginx in step 8b.5.
      # Roll remaining workers one at a time: remove from nginx → restart → HC → re-add → settle.
      # At every moment N-1 workers serve production traffic — no single-worker window.
      REMAINING_ROLL=()
      for _p in "${TARGET_PORTS[@]}"; do
        [ "$_p" != "${NEW_PORT}" ] && REMAINING_ROLL+=("$_p")
      done
      # Reverse order: roll highest-numbered non-canonical ports first, OLD_PORT (canonical) last.
      REMAINING_ROLL_REV=()
      for (( _ri=${#REMAINING_ROLL[@]}-1; _ri>=0; _ri-- )); do
        REMAINING_ROLL_REV+=("${REMAINING_ROLL[$_ri]}")
      done

      for roll_port in "${REMAINING_ROLL_REV[@]}"; do
        echo "--- Rolling worker :${roll_port} to ${RELEASE_SHA} ---"

        # 1. Build upstream CSV without this port (N-1 workers serve).
        _ROLL_EXCL_CSV=""
        for _p in "${TARGET_PORTS[@]}"; do
          [ "$_p" != "${roll_port}" ] && _ROLL_EXCL_CSV="${_ROLL_EXCL_CSV:+${_ROLL_EXCL_CSV},}${_p}"
        done

        # 2. Remove roll_port from nginx — remaining N-1 workers absorb all traffic.
        rewrite_nginx_upstream "${_ROLL_EXCL_CSV}" "remove :${roll_port} before roll" || {
          echo "ERROR: failed to remove :${roll_port} from nginx"; rollback_cutover; exit 1
        }
        # Brief drain: nginx reload is graceful but old worker processes may still hold keepalive
        # connections to the now-removed upstream.  2s is enough for those connections to drain
        # before SIGTERM is sent.
        sleep 2

        # 3. Restart worker on new release (shared safe restart helper).
        if ! restart_worker_on_release "${roll_port}"; then
          echo "ERROR: roll failed on :${roll_port}"
          rollback_cutover
          exit 1
        fi

        # 4. Health check isolated worker (not yet in nginx upstream).
        if ! ssh_prod "/tmp/health-check.sh ${roll_port} http://127.0.0.1:${roll_port}"; then
          echo "ERROR: health check failed on :${roll_port}"
          rollback_cutover; exit 1
        fi

        # 5. Re-add roll_port to nginx (N workers active again).
        rewrite_nginx_upstream "${TARGET_PORTS_CSV}" "restore :${roll_port} after roll" || {
          echo "ERROR: failed to restore :${roll_port} to nginx"; rollback_cutover; exit 1
        }

        # 6. Settle: let WS clients reconnect to updated worker before rolling the next.
        echo "  Settling ${WORKER_SETTLE_SECS}s for WS reconnects..."
        sleep "${WORKER_SETTLE_SECS}"
        deploy_log_phase "rolled :${roll_port}"
      done

      NGINX_CANDIDATE_PIN_ACTIVE=0
      gate_same_release || { rollback_cutover; exit 1; }
      gate_all_worker_health || { rollback_cutover; exit 1; }
      gate_upstream_parity || { rollback_cutover; exit 1; }
      deploy_log_phase "rolling restart complete (all ${CHATAPP_INSTANCES} workers) + parity gates OK"
      echo "✓ Rolling restart complete"

    else
      # ---- Spare-port cutover (CHATAPP_INSTANCES == 2 / staging) ----
      if [ "${PIN_CANDIDATE_BEFORE_COMPANION}" = "true" ]; then
        echo "9a. Pinning nginx to candidate (${NEW_PORT}) before companion restart..."
        ssh_prod "
          set -euo pipefail
          export NEW_PORT='${NEW_PORT}'
          export SITE='${CHATAPP_NGINX_SITE_PATH}'
          TMP_SITE=\$(mktemp)
          sudo cp \"\$SITE\" \"\$TMP_SITE\"
          export TMP_SITE
          python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
newp = os.environ['NEW_PORT']
keepalive = '''  keepalive 16;
  keepalive_requests 100;
  keepalive_timeout 10s;
'''
block = (
    'upstream app {\\n'
    '  server localhost:%s max_fails=0;\\n' % newp
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('step 9a: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
          sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
          rm -f \"\$TMP_SITE\"
          sudo nginx -t >/dev/null
          sudo systemctl reload nginx
          echo 'Nginx: candidate-only upstream before companion roll'
        " || {
          echo "ERROR: Nginx pin to candidate (9a) failed."
          rollback_cutover
          exit 1
        }
        NGINX_CANDIDATE_PIN_ACTIVE=1
        echo "✓ Nginx pinned to candidate"
        gate_ingress_canary || {
          rollback_cutover
          exit 1
        }
      else
        echo "9a. Skipping nginx pin (PIN_CANDIDATE_BEFORE_COMPANION=false) — ensure /api/ proxy_next_upstream includes non_idempotent."
        echo "✓ Companion restart may briefly 502 POST if an upstream is down"
      fi

      echo "9a.1 Verifying candidate stays healthy before companion restart..."
      if ! ssh_prod "
        set -euo pipefail
        ok=0
        health_log=/tmp/chatapp-candidate-health-${NEW_PORT}.log
        rm -f \"\$health_log\"
        for i in 1 2 3; do
          if /tmp/health-check.sh ${NEW_PORT} http://127.0.0.1:${NEW_PORT} >\"\$health_log\" 2>&1; then
            ok=\$((ok+1))
          else
            ok=0
          fi
          sleep 1
        done
        if [ \"\$ok\" -lt 3 ]; then
          echo '--- Candidate health-check output (tail) ---'
          tail -n 80 \"\$health_log\" || true
          echo '--- Candidate service journal (recent) ---'
          sudo journalctl -u chatapp@${NEW_PORT} --no-pager -n 80 || true
          exit 1
        fi
      "; then
        echo "ERROR: Candidate failed consecutive health checks just before companion roll."
        rollback_cutover
        exit 1
      fi

      echo "9b. Rolling companion on port ${OLD_PORT} to ${RELEASE_SHA}..."
      if ! restart_worker_on_release "${OLD_PORT}"; then
        echo "ERROR: Companion roll to ${RELEASE_SHA} failed."
        rollback_cutover
        exit 1
      fi
      echo "Companion chatapp@${OLD_PORT} restarted on new release"
      if ! ssh_prod "/tmp/health-check.sh ${OLD_PORT} http://127.0.0.1:${OLD_PORT}"; then
        echo "ERROR: Health check failed on companion port ${OLD_PORT}."
        rollback_cutover
        exit 1
      fi
      if ! ssh_prod "
        set -euo pipefail
        fails=0
        for i in 1 2 3 4; do
          /tmp/health-check.sh ${OLD_PORT} http://127.0.0.1:${OLD_PORT} >/dev/null 2>&1 || fails=\$((fails+1))
          sleep 1
        done
        [ \"\$fails\" -eq 0 ]
      "; then
        echo "ERROR: Companion port ${OLD_PORT} failed warm-up checks."
        rollback_cutover
        exit 1
      fi

      if [ "${#ADDITIONAL_PORTS[@]}" -gt 0 ]; then
        echo "9b.5. Rolling additional worker ports (${ADDITIONAL_PORTS[*]}) to ${RELEASE_SHA}..."
        echo "  Settling ${WORKER_SETTLE_SECS}s after OLD_PORT restart before rolling additional workers..."
        sleep "${WORKER_SETTLE_SECS}"
        for extra_port in "${ADDITIONAL_PORTS[@]}"; do
          if ! restart_worker_on_release "${extra_port}"; then
            echo "ERROR: Rolling additional worker port ${extra_port} failed."
            rollback_cutover
            exit 1
          fi
          hc_ok=0
          for attempt in 1 2 3 4 5; do
            if ssh_prod "/tmp/health-check.sh ${extra_port} http://127.0.0.1:${extra_port}"; then
              hc_ok=1
              break
            fi
            echo "WARN: health-check on :${extra_port} attempt ${attempt} failed (SSH flake or slow start); retrying in 3s..."
            sleep 3
          done
          if [ "${hc_ok}" -ne 1 ]; then
            echo "ERROR: Health check failed on additional worker port ${extra_port} after retries."
            rollback_cutover
            exit 1
          fi
          echo "  Settling ${WORKER_SETTLE_SECS}s for WS clients to reconnect before next worker restart..."
          sleep "${WORKER_SETTLE_SECS}"
        done
      fi

      echo "9c. Restoring nginx upstream (least_conn, all ${CHATAPP_INSTANCES} workers)..."
      gate_same_release || {
        rollback_cutover
        exit 1
      }
      CHATAPP_INSTANCES_HIGH_START=$((4000 + CHATAPP_INSTANCES))
      ssh_prod "
        set -euo pipefail
        export TARGET_PORTS_CSV='${TARGET_PORTS_CSV}'
        export SITE='${CHATAPP_NGINX_SITE_PATH}'
        TMP_SITE=\$(mktemp)
        sudo cp \"\$SITE\" \"\$TMP_SITE\"
        export TMP_SITE
        python3 <<'PY'
import os, re
cfg_path = os.environ['TMP_SITE']
ports = [p.strip() for p in os.environ['TARGET_PORTS_CSV'].split(',') if p.strip()]
if not ports:
    raise SystemExit('step 9c: no target ports provided')
keepalive = '''  keepalive 512;
  keepalive_requests 100000;
  keepalive_timeout 75s;
'''
servers = ''.join(f'  server localhost:{p} max_fails=0;\\n' for p in ports)
block = (
    'upstream app {\\n'
    '  least_conn;\\n'
    + servers
    + keepalive
    + '}'
)
text = open(cfg_path).read()
text, n = re.subn(r'upstream app \\{[^}]+\\}', block, text, count=1, flags=re.DOTALL)
if n != 1:
    raise SystemExit('step 9c: upstream app block not replaced (n=%d)' % (n,))
open(cfg_path, 'w').write(text)
PY
        sudo install -m 644 \"\$TMP_SITE\" \"\$SITE\"
        rm -f \"\$TMP_SITE\"
        sudo nginx -t >/dev/null
        sudo systemctl reload nginx
        for p in ${TARGET_PORTS_CSV//,/ }; do
          sudo systemctl enable chatapp@\$p 2>/dev/null || true
        done
        # Belt-and-suspenders: stop/disable any higher-numbered workers (e.g. @4004 when CHATAPP_INSTANCES=4)
        # so a previous deploy or manual start cannot leave them enabled after nginx only lists TARGET_PORTS.
        for p in \$(seq ${CHATAPP_INSTANCES_HIGH_START} 4007); do
          sudo systemctl stop chatapp@\${p} 2>/dev/null || true
          sudo systemctl disable chatapp@\${p} 2>/dev/null || true
        done
        echo 'Nginx: load-balanced ports ${TARGET_PORTS_CSV}'
      " || {
        echo "ERROR: Nginx upstream rewrite failed (multi-worker restore)."
        rollback_cutover
        exit 1
      }
      NGINX_CANDIDATE_PIN_ACTIVE=0

      # Spare candidate (e.g. :4004 when CHATAPP_INSTANCES=4) must not stay running — it breaks
      # gate_upstream_parity (unexpected active worker) and wastes RAM.
      if ! printf '%s\n' "${TARGET_PORTS[@]}" | grep -qx "${NEW_PORT}"; then
        echo "9c.1 Stopping spare candidate chatapp@${NEW_PORT} before upstream parity gates..."
        ssh_prod "
          set -euo pipefail
          sudo systemctl stop chatapp@${NEW_PORT} 2>/dev/null || true
          sudo systemctl disable chatapp@${NEW_PORT} 2>/dev/null || true
        " || true
        echo "✓ Spare candidate stopped"
      fi

      gate_all_worker_health || {
        rollback_cutover
        exit 1
      }
      gate_upstream_parity || {
        rollback_cutover
        exit 1
      }
      deploy_log_phase "multi-worker cutover (9c) + parity gates OK"
      echo "OK: Multi-worker nginx upstream restored"
    fi  # end else (spare-port)
  fi
}

deploy_prod_run_monitor_window_and_reclaim() {
  # 10. Monitor briefly
  MONITOR_CHECKS=$((MONITOR_SECONDS / 5))
  if [ "$MONITOR_CHECKS" -lt 1 ]; then
    MONITOR_CHECKS=1
  fi

  echo "10. Monitoring for ${MONITOR_SECONDS} seconds..."
  MONITOR_FAILS=0
  for i in $(seq 1 "$MONITOR_CHECKS"); do
    sleep 5
    if gate_all_worker_health >/dev/null 2>&1; then
      echo "  ✓ Check $i/$MONITOR_CHECKS passed"
    else
      echo "  ✗ Check $i/$MONITOR_CHECKS: all-worker health gate failed"
      MONITOR_FAILS=$((MONITOR_FAILS + 1))
    fi
  done
  if [ "$MONITOR_FAILS" -gt 0 ]; then
    echo "ERROR: Candidate failed ${MONITOR_FAILS}/${MONITOR_CHECKS} monitor checks after cutover."
    rollback_cutover
    exit 1
  fi
  echo "✓ Monitoring window complete"

  # 10.45. Spare candidate is reclaimed in 9c.1 (multi-worker). Single-worker uses NEW_PORT in TARGET.

  # 10.5. Stop old port to reclaim memory.
  # Prod runs a single instance (CHATAPP_INSTANCES=1); the old port stays running
  # through the monitoring window for emergency rollback, but afterwards its RAM
  # (~125 MB) is more valuable than instant-rollback convenience on a 2 GB VM.
  # To roll back after this point: re-run this script with the previous SHA.
  if [ "${RECLAIM_OLD_PORT}" = "true" ]; then
    echo "10.5. Stopping old instance on port ${OLD_PORT} to reclaim RAM..."
    ssh_prod "
      sudo systemctl stop chatapp@${OLD_PORT} 2>/dev/null || true
      sudo systemctl disable chatapp@${OLD_PORT} 2>/dev/null || true
      echo 'Old instance stopped'"
    echo "✓ Old instance stopped (rollback now requires re-deploy)"
  else
    echo "10.5. Keeping old instance on port ${OLD_PORT} for fast rollback safety."
  fi
}
