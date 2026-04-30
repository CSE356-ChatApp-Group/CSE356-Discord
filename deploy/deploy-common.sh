# deploy/deploy-common.sh
# Shared constants and SSH/SCP helpers for deploy tooling.
# Sourced by: deploy-prod.sh, deploy-staging.sh, deploy-prod-multi.sh, preflight-check.sh;
# rollback.sh relies on these helpers when sourced from deploy-prod.sh.
# shellcheck shell=bash

: "${CHATAPP_NGINX_SITE_PATH:=/etc/nginx/sites-available/chatapp}"

# Open-source nginx: POST retry to the next upstream requires the non_idempotent keyword
# on proxy_next_upstream (there is no separate proxy_next_upstream_non_idempotent directive).
# Include http_503 so that requests landing on a worker that is mid-shutdown (pool circuit
# breaker or Node draining) are retried on a healthy peer.  OVERLOAD_HTTP_SHED_ENABLED=false
# on prod, so overload-shedding 503s are never emitted and the max_fails concern is moot.
# Use proxy_next_upstream_tries 0 (nginx default semantics: try all peers in the group).
# tries=2 breaks multi-VM rolling deploys: least_conn can pick two restarting workers →
# connect() refused to upstream while other workers are healthy.
# shellcheck disable=SC2034 # read by preflight-check.sh and deploy-prod-nginx-patches.sh after sourcing
CHATAPP_NGINX_PROXY_RETRY_LINE='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'
# shellcheck disable=SC2034
CHATAPP_NGINX_PROXY_RETRY_LINE_LEGACY='proxy_next_upstream error timeout http_502 http_503 http_504 non_idempotent;'

# --- Multiplexed scp to a prod-family VM (ControlPath must match deploy-prod-multi.sh ssh_vm). ---
# Requires: PROD_USER. Optional: DEPLOY_SSH_EXTRA_OPTS.
chatapp_scp_to_multi_vm() {
  local host="${1:?host required}"
  shift
  # shellcheck disable=SC2086
  scp -q \
    -o BatchMode=yes -o ConnectTimeout=25 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-multi-%r@"${host}":%p \
    -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "$@"
}

# --- Production app VM (ControlPath must match deploy-prod.sh ssh_prod). ---
# Requires: PROD_USER, PROD_HOST. Optional: DEPLOY_SSH_EXTRA_OPTS.
chatapp_scp_to_prod() {
  # shellcheck disable=SC2086
  scp -q \
    -o BatchMode=yes -o ConnectTimeout=20 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-prod-%r@%h:%p -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "$@"
}

# Pull a single file from the production app host (same mux socket as chatapp_scp_to_prod).
# Usage: chatapp_scp_from_prod <remote_path> <local_path>
chatapp_scp_from_prod() {
  local remote="$1" local_path="$2"
  # shellcheck disable=SC2086
  scp -q \
    -o BatchMode=yes -o ConnectTimeout=20 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-prod-%r@%h:%p -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "${PROD_USER}@${PROD_HOST}:${remote}" "${local_path}"
}

# --- Monitoring VM (ControlPath must match deploy-prod.sh ssh_monitor). ---
# Requires: MONITORING_VM_USER, MONITORING_VM_HOST.
chatapp_scp_to_monitor() {
  # shellcheck disable=SC2086
  scp -q \
    -o BatchMode=yes -o ConnectTimeout=25 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-monitor-%r@%h:%p -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "$@"
}

chatapp_scp_recursive_to_monitor() {
  # shellcheck disable=SC2086
  scp -qr \
    -o BatchMode=yes -o ConnectTimeout=60 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-monitor-%r@%h:%p -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "$@"
}

# --- Staging app host (separate ControlMaster socket from prod / multi-VM). ---
# Requires: STAGING_USER, STAGING_HOST. Optional: DEPLOY_SSH_EXTRA_OPTS.
chatapp_ssh_staging_app() {
  # shellcheck disable=SC2086
  ssh -o ServerAliveInterval=20 -o ServerAliveCountMax=5 \
      -o BatchMode=yes -o ConnectTimeout=25 \
      -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-staging-%r@%h:%p -o ControlPersist=10m \
      ${DEPLOY_SSH_EXTRA_OPTS:-} \
      "${STAGING_USER}@${STAGING_HOST}" "$@"
}

chatapp_scp_to_staging_app() {
  # shellcheck disable=SC2086
  scp -q \
    -o BatchMode=yes -o ConnectTimeout=25 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-staging-%r@%h:%p -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "$@"
}

# Pull a file from the staging app host (same mux as chatapp_scp_to_staging_app).
chatapp_scp_from_staging_app() {
  local remote="$1" local_path="$2"
  # shellcheck disable=SC2086
  scp -q \
    -o BatchMode=yes -o ConnectTimeout=25 \
    -o ControlMaster=auto -o ControlPath=/tmp/ssh-chatapp-staging-%r@%h:%p -o ControlPersist=10m \
    ${DEPLOY_SSH_EXTRA_OPTS:-} \
    "${STAGING_USER}@${STAGING_HOST}:${remote}" "${local_path}"
}
