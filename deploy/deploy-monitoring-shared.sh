# deploy/deploy-monitoring-shared.sh
# Shared monitoring helpers for deploy scripts.
# shellcheck shell=bash

# Render prometheus-host.yml from template with optional multi-VM and nginx-job controls.
# Args:
#   1 template path
#   2 output path
#   3 app-host (required)
#   4 workers (single-VM mode; optional when vm1-workers is set)
#   5 omit-nginx-job flag (0/1)
#   6 vm1-workers (optional; enables multi-VM mode when >0)
#   7 vm2-host (optional)
#   8 vm2-workers (optional)
#   9 vm3-host (optional)
#  10 vm3-workers (optional)
#  11 redis-host (optional; defaults to app-host in renderer)
deploy_render_prometheus_host_config() {
  local template_path="${1:?template path required}"
  local output_path="${2:?output path required}"
  local app_host="${3:?app host required}"
  local workers="${4:-0}"
  local omit_nginx_job="${5:-0}"
  local vm1_workers="${6:-0}"
  local vm2_host="${7:-}"
  local vm2_workers="${8:-0}"
  local vm3_host="${9:-}"
  local vm3_workers="${10:-0}"
  local redis_host="${11:-}"

  local -a cmd
  cmd=(
    python3 "${SCRIPT_DIR}/render-prometheus-host-config.py"
    --template "${template_path}"
    --output "${output_path}"
    --app-host "${app_host}"
  )

  if [ "${vm1_workers}" -gt 0 ]; then
    cmd+=(--vm1-workers "${vm1_workers}")
    if [ -n "${vm2_host}" ] && [ "${vm2_workers}" -gt 0 ]; then
      cmd+=(--vm2-host "${vm2_host}" --vm2-workers "${vm2_workers}")
    fi
    if [ -n "${vm3_host}" ] && [ "${vm3_workers}" -gt 0 ]; then
      cmd+=(--vm3-host "${vm3_host}" --vm3-workers "${vm3_workers}")
    fi
  else
    cmd+=(--workers "${workers}")
  fi

  if [ "${omit_nginx_job}" = "1" ]; then
    cmd+=(--omit-nginx-job)
  fi
  if [ -n "${redis_host}" ]; then
    cmd+=(--redis-host "${redis_host}")
  fi

  "${cmd[@]}"
}

# Build docker compose command for app-VM monitoring services.
# Args:
#   1 compose file path on remote host
#   2 enable edge profile/services (0/1)
deploy_monitoring_remote_compose_up_cmd() {
  local compose_file="${1:?compose file required}"
  local enable_edge="${2:-0}"
  if [ "${enable_edge}" = "1" ]; then
    echo "sudo docker compose -f ${compose_file} --profile edge up -d --remove-orphans node-exporter promtail nginx-exporter"
  else
    echo "sudo docker compose -f ${compose_file} up -d --remove-orphans node-exporter promtail"
  fi
}
