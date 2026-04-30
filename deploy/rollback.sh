# deploy/rollback.sh — sourced by deploy-prod.sh after deploy-common.sh
# Uses: ssh_prod, chatapp_scp_to_prod, capture_previous_release_map, rewrite_nginx_upstream,
#       deploy_log_phase, notify_discord_prod, gate_* , RELEASE_*, PROD_*, TARGET_PORTS, etc.
# shellcheck shell=bash

# Fast rollback: roll all workers to an already-deployed release on the server.
# Skips backup, artifact download, npm ci, migrations, pgbouncer setup, monitoring.
# Completes in ~2-3 minutes. Invoked by deploy-prod.sh <sha> --rollback.
do_fast_rollback() {
  local sha="${RELEASE_SHA}"
  local release_path="${RELEASE_DIR}/${sha}"

  echo ""
  echo "=== FAST ROLLBACK to ${sha} ==="
  echo "Release path: ${release_path}"

  # Verify the release exists on the server (must have been deployed previously)
  if ! ssh_prod "[ -d '${release_path}/backend' ]"; then
    echo "ERROR: Release ${sha} not found at ${release_path}/backend on ${PROD_HOST}"
    echo "Available releases (most recent first):"
    ssh_prod "ls -1t '${RELEASE_DIR}' 2>/dev/null | head -10" || true
    exit 1
  fi
  echo "✓ Release found on server"

  # Ensure health-check.sh is in place on the server
  chatapp_scp_to_prod "${SCRIPT_DIR}/health-check.sh" "${PROD_USER}@${PROD_HOST}:/tmp/health-check.sh"
  ssh_prod "chmod +x /tmp/health-check.sh"

  notify_discord_prod ":arrow_left: **Prod rollback starting** \`${sha:0:7}\` · ${CHATAPP_INSTANCES} workers"
  deploy_log_phase "rollback: beginning rolling worker swap"

  # Reapply the release-owned env profile when present. Runtime env lives in
  # /opt/chatapp/shared/.env, so swapping only the systemd WorkingDirectory is
  # not a true rollback if the previous deploy changed profile-owned keys.
  ssh_prod "
    set -euo pipefail
    if [ -f '${release_path}/deploy/apply-env-profile.py' ] && [ -f '${release_path}/deploy/env/prod.required.env' ]; then
      sudo python3 '${release_path}/deploy/apply-env-profile.py' \
        --target /opt/chatapp/shared/.env \
        --required '${release_path}/deploy/env/prod.required.env'
      echo 'rollback env profile applied from release artifact'
    else
      echo 'WARN: rollback release has no bundled env profile; shared .env left unchanged'
    fi
  "

  # Snapshot current worker state so exit trap can attempt recovery if rollback fails
  capture_previous_release_map

  # Rolling restart: one worker at a time → no capacity drop below (N-1)/N
  local _rb_settle=8   # 8s: matches WS_APP_KEEPALIVE_INTERVAL_MS so clients reconnect
  for roll_port in "${TARGET_PORTS[@]}"; do
    echo "--- Rolling back :${roll_port} → ${sha} ---"

    # Build upstream CSV without this port
    local _excl_csv=""
    for _p in "${TARGET_PORTS[@]}"; do
      if [ "$_p" != "${roll_port}" ]; then
        _excl_csv="${_excl_csv:+${_excl_csv},}${_p}"
      fi
    done

    # Drain traffic from this port before restart
    if [[ -n "${_excl_csv}" ]]; then
      rewrite_nginx_upstream "${_excl_csv}" "rollback: remove :${roll_port}" || {
        echo "ERROR: could not remove :${roll_port} from nginx during rollback"
        exit 1
      }
      sleep 2  # drain: let nginx old-worker keepalive connections clear before SIGTERM
    fi

    # Point systemd dropin at rollback release and restart
    ssh_prod "
      set -euo pipefail
      DROPIN_DIR=/etc/systemd/system/chatapp@${roll_port}.service.d
      sudo mkdir -p \"\$DROPIN_DIR\"
      printf '[Service]\nWorkingDirectory=%s/backend\n' '${release_path}' \
        | sudo tee \"\${DROPIN_DIR}/release.conf\" >/dev/null
      sudo systemctl daemon-reload
      sudo systemctl reset-failed chatapp@${roll_port} 2>/dev/null || true
      sudo systemctl restart chatapp@${roll_port}
    " || {
      echo "ERROR: chatapp@${roll_port} restart failed during rollback"
      exit 1
    }

    # Wait for the worker to pass health checks before restoring it to nginx
    if ! ssh_prod "/tmp/health-check.sh ${roll_port} http://127.0.0.1:${roll_port}"; then
      echo "ERROR: health check failed for :${roll_port} after rollback restart"
      exit 1
    fi

    # Restore port to nginx upstream
    rewrite_nginx_upstream "${TARGET_PORTS_CSV}" "rollback: restore :${roll_port}" || {
      echo "ERROR: could not restore :${roll_port} to nginx after rollback restart"
      exit 1
    }

    echo "  Settling ${_rb_settle}s for WS clients to reconnect..."
    sleep "${_rb_settle}"
  done

  deploy_log_phase "rollback: all workers restarted"

  # Update current symlink to the rollback release
  ssh_prod "ln -sfn '${release_path}' '${CURRENT_LINK}'" \
    && echo "✓ /opt/chatapp/current → ${sha}" \
    || echo "WARN: symlink update failed (non-fatal)"

  # Final verification gates
  if gate_all_worker_health && gate_upstream_parity && gate_same_release; then
    local _rb_done
    _rb_done=$(date +%s)
    notify_discord_prod ":white_check_mark: **Prod rollback complete** \`${sha:0:7}\` · $((${_rb_done} - ${_DEPLOY_T0}))s"
    echo ""
    echo "=== Rollback Complete ==="
    echo "Production is now running: ${sha}"
  else
    echo "ERROR: Final gates failed after rollback — production may be degraded."
    echo "       Manual intervention required: check journalctl -u 'chatapp@*' on ${PROD_HOST}"
    exit 1
  fi
}
