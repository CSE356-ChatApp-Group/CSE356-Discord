#!/usr/bin/env bash
# Move PostgreSQL data to a dedicated block device (e.g. unused Linode volume /dev/vdb).
#
# WHEN TO RUN
#   Maintenance window only: stop app traffic (or accept brief outage), then run as root
#   ON THE DATABASE SERVER.
#
# WHAT IT DOES
#   1. Stops postgresql
#   2. mkfs.ext4 on the device (DESTRUCTIVE unless already ext4 and you skip mkfs — see env)
#   3. rsync existing data_directory → mounted volume
#   4. Replaces the old directory with a mount point + /etc/fstab UUID entry
#   5. Starts postgresql
#
# ROLLBACK
#   If postgres fails to start, the script leaves *.bak.* next to the cluster dir; see stderr.
#
# Usage (DB VM as root), empty volume OR wipe:
#   I_ACCEPT_VOLUME_DATADIR_MIGRATION_RISK=yes DATA_DEVICE=/dev/vdb \
#     DATA_DEVICE_WIPE_EXISTING_FS=yes ./postgres-migrate-data-volume.sh
#
set -euo pipefail

: "${I_ACCEPT_VOLUME_DATADIR_MIGRATION_RISK:=}"
if [[ "${I_ACCEPT_VOLUME_DATADIR_MIGRATION_RISK}" != "yes" ]]; then
  echo "Refusing to run. Set I_ACCEPT_VOLUME_DATADIR_MIGRATION_RISK=yes after reading this script."
  exit 1
fi

DATA_DEVICE="${DATA_DEVICE:-/dev/vdb}"
PG_VERSION="${PG_VERSION:-}"
STAGING="${STAGING:-/mnt/chatapp-pgdata-staging}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "run as root on the database server"

[[ -b "$DATA_DEVICE" ]] || die "not a block device: ${DATA_DEVICE}"

if findmnt -S "$DATA_DEVICE" &>/dev/null; then
  die "${DATA_DEVICE} is already mounted — unmount or pick another device"
fi

detect_pg_version() {
  if [[ -n "$PG_VERSION" ]]; then
    echo "$PG_VERSION"
    return
  fi
  local num
  num="$(sudo -u postgres psql -d postgres -tAc 'SHOW server_version_num;' 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ "$num" =~ ^[0-9]{2,} ]]; then
    echo "${num:0:2}"
    return
  fi
  local guess
  guess="$(ls -1 /etc/postgresql 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$guess" ]] || die "could not detect PG version; set PG_VERSION=16"
  echo "$guess"
}

PGV="$(detect_pg_version)"
CLUSTER_DIR="/var/lib/postgresql/${PGV}/main"
[[ -d "$CLUSTER_DIR" ]] || die "cluster dir missing: $CLUSTER_DIR (set PG_VERSION?)"

OLD_DATA="$(sudo -u postgres psql -d postgres -tAc 'SHOW data_directory;' 2>/dev/null | tr -d '[:space:]')"
[[ -n "$OLD_DATA" ]] || die "could not read data_directory"
[[ "$OLD_DATA" == "$CLUSTER_DIR" ]] || die "data_directory=${OLD_DATA} differs from expected ${CLUSTER_DIR} — adjust script or cluster layout"

EXISTING_FS="$(blkid -o value -s TYPE "$DATA_DEVICE" 2>/dev/null || true)"
if [[ -n "$EXISTING_FS" && "$EXISTING_FS" != "ext4" ]]; then
  die "${DATA_DEVICE} has fstype=${EXISTING_FS} (need ext4 or empty device)"
fi
if [[ -n "$EXISTING_FS" && "${DATA_DEVICE_WIPE_EXISTING_FS:-}" != "yes" ]]; then
  die "${DATA_DEVICE} already has a filesystem. Empty volume or set DATA_DEVICE_WIPE_EXISTING_FS=yes to mkfs.ext4 -F (DESTROYS DATA)."
fi
echo "mkfs.ext4 -F ${DATA_DEVICE}"
mkfs.ext4 -F "$DATA_DEVICE"

UUID="$(blkid -s UUID -o value "$DATA_DEVICE")"
[[ -n "$UUID" ]] || die "no UUID for ${DATA_DEVICE}"

echo "==> Stopping PostgreSQL"
systemctl stop postgresql

mkdir -p "$STAGING"
mount "$DATA_DEVICE" "$STAGING"
chown postgres:postgres "$STAGING"
chmod 700 "$STAGING"

echo "==> Rsync data (this may take a long time)"
rsync -aX --delete --exclude 'lost+found' "${CLUSTER_DIR}/" "${STAGING}/"

umount "$STAGING"
rmdir "$STAGING" 2>/dev/null || true

BAK_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
mv "$CLUSTER_DIR" "${CLUSTER_DIR}.bak.${BAK_TAG}"
mkdir -p "$CLUSTER_DIR"
mount "$DATA_DEVICE" "$CLUSTER_DIR"
chown -R postgres:postgres "$CLUSTER_DIR"

FSTAB_LINE="UUID=${UUID} ${CLUSTER_DIR} ext4 defaults,nofail 0 2"
if grep -qF "$CLUSTER_DIR" /etc/fstab; then
  echo "WARNING: /etc/fstab already mentions ${CLUSTER_DIR} — fix duplicates manually"
else
  echo "$FSTAB_LINE" >> /etc/fstab
fi

echo "==> Starting PostgreSQL"
systemctl start postgresql
sleep 2
systemctl is-active --quiet postgresql || die "postgresql failed to start — old data at ${CLUSTER_DIR}.bak.${BAK_TAG}"

sudo -u postgres psql -d postgres -v ON_ERROR_STOP=1 -c 'SELECT 1 AS ok;'

echo "=== Migration finished ==="
echo "  Old directory: ${CLUSTER_DIR}.bak.${BAK_TAG} (delete after verification)"
echo "  Mount: ${DATA_DEVICE} -> ${CLUSTER_DIR} (fstab UUID=${UUID})"
