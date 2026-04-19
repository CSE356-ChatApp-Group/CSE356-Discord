#!/usr/bin/env bash
# Idempotent disk hygiene for the production *app* VM (run on-host or via ssh).
# - Adds maxsize to packaged nginx logrotate so huge access.log rotates before "daily".
# - Vacuums systemd journal (bounded size).
# - apt-get clean.
# - Optionally forces nginx logrotate once (best-effort).
#
# Usage (on the app host):
#   sudo DRY_RUN=1 ./deploy/prod-disk-hygiene.sh   # print actions only
#   sudo ./deploy/prod-disk-hygiene.sh
#
# Env:
#   DRY_RUN=1              — no writes
#   JOURNAL_VACUUM_SIZE    — default 800M (passed to journalctl --vacuum-size)

set -euo pipefail

DRY_RUN="${DRY_RUN:-0}"
JOURNAL_VACUUM_SIZE="${JOURNAL_VACUUM_SIZE:-800M}"

log() { echo "[prod-disk-hygiene] $*"; }

ensure_nginx_logrotate_maxsize() {
  local f=/etc/logrotate.d/nginx
  if [[ ! -f "$f" ]]; then
    log "WARN: $f missing — skip maxsize patch (custom nginx install?)"
    return 0
  fi
  if grep -qE '^[[:space:]]*maxsize[[:space:]]' "$f"; then
    log "nginx logrotate: maxsize already configured"
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: would insert 'maxsize 200M' after the first 'daily' line in $f"
    return 0
  fi
  # Insert after the first "daily" (package file uses tabs — [[:space:]] matches).
  sudo sed -i '/^[[:space:]]*daily[[:space:]]*$/a maxsize 200M' "$f"
  log "nginx logrotate: inserted maxsize 200M (rotate when any /var/log/nginx/*.log exceeds 200M)"
}

vacuum_journal() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: journalctl --vacuum-size=${JOURNAL_VACUUM_SIZE}"
    return 0
  fi
  sudo journalctl --vacuum-size="${JOURNAL_VACUUM_SIZE}"
}

apt_clean_safe() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: apt-get clean"
    return 0
  fi
  sudo apt-get clean || true
}

force_nginx_logrotate_once() {
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN: logrotate -f /etc/logrotate.d/nginx"
    return 0
  fi
  if [[ -f /etc/logrotate.d/nginx ]]; then
    sudo logrotate -f /etc/logrotate.d/nginx 2>/dev/null || log "WARN: logrotate -f nginx returned non-zero (ignore if logs empty)"
  fi
}

main() {
  if [[ "$(id -u)" -ne 0 ]] && [[ "$DRY_RUN" != "1" ]]; then
    log "Re-exec with sudo (required for journal/apt/logrotate writes)"
    exec sudo DRY_RUN="${DRY_RUN}" JOURNAL_VACUUM_SIZE="${JOURNAL_VACUUM_SIZE}" "$0" "$@"
  fi

  ensure_nginx_logrotate_maxsize
  vacuum_journal
  apt_clean_safe
  force_nginx_logrotate_once

  log "df -h /"
  df -h /
}

main "$@"
