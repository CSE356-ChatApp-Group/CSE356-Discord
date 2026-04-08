#!/usr/bin/env bash
# Verifies ChatApp Postgres schema after deploy (especially migration 009).
#
# Usage:
#   DATABASE_URL='postgres://...' ./deploy/verify-schema.sh
#
# Exits 0 if checks pass; non-zero with a short message otherwise.
#
# Recovery: if 009 partially applied (columns exist but row missing in schema_migrations),
# do NOT blindly re-run the raw SQL file — inspect channels + schema_migrations, then
# either INSERT the migration row after manual verification or fix with DBA guidance.
# See deploy/README.md § "Post-deploy schema verification".

set -euo pipefail

require_env() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "error: DATABASE_URL is not set" >&2
    exit 1
  fi
}

require_env

MIGRATION='009_channel_last_message_denorm.sql'

echo "Checking schema_migrations for ${MIGRATION}..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt -c \
  "SELECT 1 FROM schema_migrations WHERE filename = '${MIGRATION}'" \
  | grep -q '^1$' || {
    echo "error: migration ${MIGRATION} not recorded in schema_migrations" >&2
    exit 2
  }

echo "Checking channels.last_message_* columns..."
col_count="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qAt -c \
  "SELECT count(*)::text FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'channels'
     AND column_name IN ('last_message_id', 'last_message_author_id', 'last_message_at')")"
if [[ "$col_count" != "3" ]]; then
  echo "error: channels table missing expected last_message_* columns (found ${col_count}, expected 3)" >&2
  exit 3
fi

echo "OK — ${MIGRATION} applied and denormalized columns present."
