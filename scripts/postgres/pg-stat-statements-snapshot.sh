#!/usr/bin/env bash
# Snapshot the heaviest normalized SQL statements from pg_stat_statements.
# Supports either a direct connection URL or an SSH hop to the DB host.
#
# Examples:
#   DATABASE_URL='postgresql://...' ./scripts/postgres/pg-stat-statements-snapshot.sh
#   DB_SSH='ubuntu@130.245.136.21' DB_NAME='chatapp_prod' ./scripts/postgres/pg-stat-statements-snapshot.sh
#   PROD_DB_SSH='ubuntu@130.245.136.21' ./scripts/postgres/pg-stat-statements-snapshot.sh   # same as prod-pg-stat-activity.sh
#
# Optional incident window (total_exec_time delta between two samples):
#   DELTA_SECONDS=120 PROD_DB_SSH=ubuntu@130.245.136.21 ./scripts/postgres/pg-stat-statements-snapshot.sh
#
# Tunables:
#   LIMIT            default 15
#   MIN_CALLS_MEAN   default 20  (filter noisy one-off statements from mean-latency view)
#   MIN_CALLS_IO     default 5   (filter one-off statements from IO-heavy view)
#   MIN_CALLS_STDDEV default 10  (stddev_exec_time view; requires PG 13+ pg_stat_statements)
set -euo pipefail

LIMIT="${LIMIT:-15}"
MIN_CALLS_MEAN="${MIN_CALLS_MEAN:-20}"
MIN_CALLS_IO="${MIN_CALLS_IO:-5}"
MIN_CALLS_STDDEV="${MIN_CALLS_STDDEV:-10}"
DB_NAME="${DB_NAME:-chatapp_prod}"
DB_SSH="${DB_SSH:-${PROD_DB_SSH:-}}"
DELTA_SECONDS="${DELTA_SECONDS:-}"

run_psql() {
  local sql="$1"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 -P pager=off -c "${sql}"
    return
  fi

  if [[ -n "${DB_SSH:-}" ]]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "${DB_SSH}" \
      "sudo -u postgres psql $(printf '%q' "${DB_NAME}") -X -v ON_ERROR_STOP=1 -P pager=off -c $(printf '%q' "${sql}")"
    return
  fi

  echo "Set DATABASE_URL or DB_SSH (or PROD_DB_SSH) to query pg_stat_statements." >&2
  exit 1
}

run_psql_tsv() {
  local sql="$1"
  # -At alone uses '|' between fields; use unit separator (unlikely in numeric cols).
  local fs=$'\x1f'
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "${DATABASE_URL}" -X -v ON_ERROR_STOP=1 -At -F "${fs}" -c "${sql}"
    return
  fi
  if [[ -n "${DB_SSH:-}" ]]; then
    # Pass -F as literal $'\x1f' to remote bash so psql gets a real ASCII 0x1f separator.
    ssh -o BatchMode=yes -o ConnectTimeout=20 "${DB_SSH}" \
      "sudo -u postgres psql $(printf '%q' "${DB_NAME}") -X -v ON_ERROR_STOP=1 -At -F \$'\\x1f' -c $(printf '%q' "${sql}")"
    return
  fi
  exit 1
}

assert_extension_sql="
SELECT extname
FROM pg_extension
WHERE extname = 'pg_stat_statements';
"

shared_cte="
WITH stats AS (
  SELECT
    queryid,
    calls,
    total_exec_time,
    mean_exec_time,
    max_exec_time,
    stddev_exec_time,
    rows,
    shared_blks_hit,
    shared_blks_read,
    temp_blks_written,
    regexp_replace(query, E'\\\\s+', ' ', 'g') AS query
  FROM pg_stat_statements
)
"

if ! run_psql "${assert_extension_sql}" | grep -q 'pg_stat_statements'; then
  echo "pg_stat_statements is not enabled on the target database." >&2
  exit 1
fi

echo "=== stats_reset (pg_stat_statements counters are cumulative since this time) ==="
run_psql "SELECT stats_reset FROM pg_stat_statements_info;" 2>/dev/null || echo "(pg_stat_statements_info not available — PG < 14 or extension without info view)"

if [[ -n "${DELTA_SECONDS}" ]] && [[ "${DELTA_SECONDS}" =~ ^[0-9]+$ ]]; then
  echo
  echo "=== DELTA_SECONDS=${DELTA_SECONDS}: capturing first sample ==="
  t0="$(mktemp)"
  t1="$(mktemp)"
  run_psql_tsv "SELECT queryid, total_exec_time, calls FROM pg_stat_statements WHERE queryid IS NOT NULL;" >"${t0}" || true
  echo "Sleeping ${DELTA_SECONDS}s for second sample..."
  sleep "${DELTA_SECONDS}"
  run_psql_tsv "SELECT queryid, total_exec_time, calls FROM pg_stat_statements WHERE queryid IS NOT NULL;" >"${t1}" || true
  echo "=== pg_stat_statements: largest total_exec_time delta in window ==="
  echo -e "queryid\tdelta_total_exec_ms\tdelta_calls"
  python3 - "${t0}" "${t1}" <<'PY'
import sys
from pathlib import Path

def load(path):
    out = {}
    for line in Path(path).read_text().splitlines():
        parts = line.split("\x1f")
        if len(parts) < 3:
            continue
        try:
            qid = int(parts[0])
            total = float(parts[1])
            calls = int(parts[2])
        except ValueError:
            continue
        out[qid] = (total, calls)
    return out

a, b = load(sys.argv[1]), load(sys.argv[2])
deltas = []
for qid, (t0, c0) in a.items():
    if qid not in b:
        continue
    t1, c1 = b[qid]
    dt = t1 - t0
    dc = c1 - c0
    if dt > 0 or dc > 0:
        deltas.append((dt, dc, qid))
deltas.sort(reverse=True)
for dt, dc, qid in deltas[:50]:
    print(f"{qid}\t{dt:.3f}\t{dc}")
PY
  rm -f "${t0}" "${t1}"
  echo "(match queryid to query text in the cumulative sections below or in Grafana.)"
  echo
fi

echo "=== pg_stat_statements: top total execution time (cumulative) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(max_exec_time::numeric, 2) AS max_exec_ms,
  rows,
  shared_blks_hit,
  shared_blks_read,
  left(query, 180) AS query
FROM stats
ORDER BY total_exec_time DESC
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: top max_exec_time (worst single call observed) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(max_exec_time::numeric, 2) AS max_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  left(query, 180) AS query
FROM stats
ORDER BY max_exec_time DESC NULLS LAST
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: top stddev_exec_time (calls >= ${MIN_CALLS_STDDEV}; volatile latency / tail) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(stddev_exec_time::numeric, 2) AS stddev_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(max_exec_time::numeric, 2) AS max_exec_ms,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  left(query, 180) AS query
FROM stats
WHERE calls >= ${MIN_CALLS_STDDEV}
ORDER BY stddev_exec_time DESC NULLS LAST
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: top calls (volume) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  left(query, 180) AS query
FROM stats
ORDER BY calls DESC
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: slowest mean execution time (calls >= ${MIN_CALLS_MEAN}) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  round(total_exec_time::numeric, 1) AS total_exec_ms,
  rows,
  left(query, 180) AS query
FROM stats
WHERE calls >= ${MIN_CALLS_MEAN}
ORDER BY mean_exec_time DESC
LIMIT ${LIMIT};
"

echo
echo "=== pg_stat_statements: most IO-heavy (shared reads + temp writes, calls >= ${MIN_CALLS_IO}) ==="
run_psql "${shared_cte}
SELECT
  queryid,
  calls,
  shared_blks_hit,
  shared_blks_read,
  temp_blks_written,
  round(mean_exec_time::numeric, 2) AS mean_exec_ms,
  left(query, 180) AS query
FROM stats
WHERE calls >= ${MIN_CALLS_IO}
ORDER BY (shared_blks_read + temp_blks_written) DESC, mean_exec_time DESC
LIMIT ${LIMIT};
"
