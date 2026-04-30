# deploy/deploy-prod-remote-sizing.sh
# Remote .env / pgbouncer.ini reads and derived pool + Node tuning for prod deploy.
# Sourced by deploy-prod.sh after CHATAPP_INSTANCES is set (requires ssh_prod).
# shellcheck shell=bash
# shellcheck disable=SC2034 # assignments read by deploy-prod.sh after source

remote_env_value() {
  local key="$1"
  ssh_prod "python3 - '$key' <<'PY'
import sys
from pathlib import Path

key = sys.argv[1]
path = Path('/opt/chatapp/shared/.env')
if not path.exists():
    raise SystemExit(0)
for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
    line = raw.strip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('export '):
        line = line[7:].strip()
    if '=' not in line:
        continue
    k, v = line.split('=', 1)
    if k.strip() == key:
        print(v.strip())
        raise SystemExit(0)
PY" 2>/dev/null || true
}

remote_pgbouncer_ini_value() {
  local key="$1"
  ssh_prod "python3 - '$key' <<'PY'
import sys
from pathlib import Path

key = sys.argv[1]
path = Path('/etc/pgbouncer/pgbouncer.ini')
if not path.exists():
    raise SystemExit(0)
for raw in path.read_text(encoding='utf-8', errors='replace').splitlines():
    line = raw.strip()
    if not line or line.startswith(';') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    if k.strip() == key:
        print(v.strip())
        raise SystemExit(0)
PY" 2>/dev/null || true
}

_REMOTE_NCPU=$(ssh_prod 'nproc --all' 2>/dev/null || echo 2)
# PgBouncer pool + Node pool math matches deploy-staging.sh (same caps, different host).
# Scale default_pool_size with **host vCPU** so 8 vCPU (etc.) actually gets more real PG
# backends than 4 vCPU. Older `min(..., 80 + inst*45)` pinned the pool at 170 for any
# 2-worker host with ≥4 cores — resizing the VM did nothing for DB capacity.
_PGB_SIZE=${PGBOUNCER_POOL_SIZE:-}
if ! [[ "${_PGB_SIZE}" =~ ^[0-9]+$ ]] || [ "${_PGB_SIZE}" -lt 1 ]; then
  _PGB_SIZE="$(remote_pgbouncer_ini_value default_pool_size)"
  _PGB_SIZE="$(printf '%s' "${_PGB_SIZE}" | tr -d '[:space:]' | tr -d '\r')"
fi
if ! [[ "${_PGB_SIZE}" =~ ^[0-9]+$ ]] || [ "${_PGB_SIZE}" -lt 1 ]; then
_PGB_SIZE=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = int('${CHATAPP_INSTANCES}')
cpu_part = ncpu * 50
extra = max(0, inst - 1) * 30
# Rolling cutover never exceeds CHATAPP_INSTANCES workers simultaneously (candidate
# port is within TARGET_PORTS; old spare-port pattern is gone). Peak load is
# inst*PG_POOL_MAX virtual connections. 500 gives a 20% buffer over the 5-worker
# peak of 5*80=400, keeping the oversubscription ratio at 0.8x (no PgBouncer queuing).
x = max(60, min(500, cpu_part + extra))
print(x)
")
fi
PG_POOL_MAX_PER_INSTANCE=${PG_POOL_MAX_PER_INSTANCE:-}
if ! [[ "${PG_POOL_MAX_PER_INSTANCE}" =~ ^[0-9]+$ ]] || [ "${PG_POOL_MAX_PER_INSTANCE}" -lt 1 ]; then
PG_POOL_MAX_PER_INSTANCE="$(remote_env_value PG_POOL_MAX)"
PG_POOL_MAX_PER_INSTANCE="$(printf '%s' "${PG_POOL_MAX_PER_INSTANCE}" | tr -d '[:space:]' | tr -d '\r')"
fi
if ! [[ "${PG_POOL_MAX_PER_INSTANCE}" =~ ^[0-9]+$ ]] || [ "${PG_POOL_MAX_PER_INSTANCE}" -lt 1 ]; then
PG_POOL_MAX_PER_INSTANCE=$(python3 -c "
p = int('${_PGB_SIZE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
ncpu = int('${_REMOTE_NCPU}')
# Cap at 80: each Node worker drives at most ~15 concurrent queries usefully (event-loop
# limit). 80 slots = 5x headroom and keeps total virtual conns (inst*80) under the
# PgBouncer default_pool_size (real PG backends), eliminating PgBouncer-side queuing.
pool_cap = min(80, 70 + ncpu * 20)
print(max(25, min(pool_cap, (p * 5) // (inst * 2))))
")
fi
POOL_CIRCUIT_BREAKER_QUEUE=$(python3 -c "
pmi = int('${PG_POOL_MAX_PER_INSTANCE}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
# Circuit breaker threshold: reject with 503 when this many queries are waiting in the
# Node pool queue. Kept at 100 — at pmi=80/worker the pool drains fast enough that
# 100 queued means genuine DB stall, not burst. Formula floor/ceiling both at 100 to
# prevent accidental drift from nproc-derived pool sizing.
print(max(96, min(100, pmi * 4 + inst * 80)))
")
PG_MAX_CONNECTIONS=${PG_MAX_CONNECTIONS:-}
if ! [[ "${PG_MAX_CONNECTIONS}" =~ ^[0-9]+$ ]] || [ "${PG_MAX_CONNECTIONS}" -lt 1 ]; then
PG_MAX_CONNECTIONS=$(python3 -c "
b = int('${_PGB_SIZE}')
# Headroom above PgBouncer default_pool_size for admin, stats, and burst.
# Cap at 1600 to support per-VM PgBouncer architecture (3 × 500-pool = 1500 total).
print(max(150, min(1600, b + 100)))
")
fi
PGBOUNCER_MAX_DB_CONNECTIONS=${PGBOUNCER_MAX_DB_CONNECTIONS:-}
if ! [[ "${PGBOUNCER_MAX_DB_CONNECTIONS}" =~ ^[0-9]+$ ]] || [ "${PGBOUNCER_MAX_DB_CONNECTIONS}" -lt "${_PGB_SIZE}" ]; then
PGBOUNCER_MAX_DB_CONNECTIONS="$(remote_pgbouncer_ini_value max_db_connections)"
PGBOUNCER_MAX_DB_CONNECTIONS="$(printf '%s' "${PGBOUNCER_MAX_DB_CONNECTIONS}" | tr -d '[:space:]' | tr -d '\r')"
fi
if ! [[ "${PGBOUNCER_MAX_DB_CONNECTIONS}" =~ ^[0-9]+$ ]] || [ "${PGBOUNCER_MAX_DB_CONNECTIONS}" -lt "${_PGB_SIZE}" ]; then
PGBOUNCER_MAX_DB_CONNECTIONS=$(python3 -c "
pool_size = int('${_PGB_SIZE}')
pg_max_conn = int('${PG_MAX_CONNECTIONS}')
print(max(pool_size, pg_max_conn - 10))
")
fi
PGBOUNCER_MIN_POOL_SIZE=${PGBOUNCER_MIN_POOL_SIZE:-}
if ! [[ "${PGBOUNCER_MIN_POOL_SIZE}" =~ ^[0-9]+$ ]] || [ "${PGBOUNCER_MIN_POOL_SIZE}" -lt 0 ]; then
PGBOUNCER_MIN_POOL_SIZE="$(remote_pgbouncer_ini_value min_pool_size)"
PGBOUNCER_MIN_POOL_SIZE="$(printf '%s' "${PGBOUNCER_MIN_POOL_SIZE}" | tr -d '[:space:]' | tr -d '\r')"
fi
if ! [[ "${PGBOUNCER_MIN_POOL_SIZE}" =~ ^[0-9]+$ ]] || [ "${PGBOUNCER_MIN_POOL_SIZE}" -lt 0 ]; then
PGBOUNCER_MIN_POOL_SIZE=$(python3 -c "print(min(20, int('${_PGB_SIZE}')))")
fi
PGBOUNCER_RESERVE_SIZE=${PGBOUNCER_RESERVE_SIZE:-}
if ! [[ "${PGBOUNCER_RESERVE_SIZE}" =~ ^[0-9]+$ ]] || [ "${PGBOUNCER_RESERVE_SIZE}" -lt 0 ]; then
PGBOUNCER_RESERVE_SIZE="$(remote_pgbouncer_ini_value reserve_pool_size)"
PGBOUNCER_RESERVE_SIZE="$(printf '%s' "${PGBOUNCER_RESERVE_SIZE}" | tr -d '[:space:]' | tr -d '\r')"
fi
if ! [[ "${PGBOUNCER_RESERVE_SIZE}" =~ ^[0-9]+$ ]] || [ "${PGBOUNCER_RESERVE_SIZE}" -lt 0 ]; then
PGBOUNCER_RESERVE_SIZE=$(python3 -c "print(max(5, int('${_REMOTE_NCPU}') * 5))")
fi
FANOUT_QUEUE_CONCURRENCY=$(python3 -c "
n = int('${_REMOTE_NCPU}')
# Parallel fanout:critical workers (Redis publishes). 8 vCPU prod was ~5; raising
# modestly improves deferred user-feed work without oversubscribing the event loop.
print(min(18, max(4, (n * 3 + 3) // 4)))
")
UV_THREADPOOL_PER_INSTANCE=$(python3 -c "print(max(8, 16 // max(1, ${CHATAPP_INSTANCES})))")
BCRYPT_MAX_CONCURRENT=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
uv = int('${UV_THREADPOOL_PER_INSTANCE}')
per_inst_cpu = (ncpu + inst - 1) // inst
print(max(4, min(uv, per_inst_cpu + 2)))
")
COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT=$(python3 -c "
ncpu = int('${_REMOTE_NCPU}')
inst = max(1, int('${CHATAPP_INSTANCES}'))
per_inst_cpu = (ncpu + inst - 1) // inst
print(max(2, min(4, per_inst_cpu - 1)))
")
# V8 max-old-space per instance: cap heap below the OOM killer threshold.
# Formula: min(1500, max(RAM_MB * 12%, 192)) — same as deploy-staging.sh.
# On a 2 GB prod machine: min(1500, max(246, 192)) = 246 MB.
_REMOTE_RAM_MB=$(ssh_prod "awk '/MemTotal/{printf \"%d\", \$2/1024}' /proc/meminfo" 2>/dev/null || echo 2048)
NODE_OLD_SPACE_MB=$(python3 -c "print(min(1500, max(192, ${_REMOTE_RAM_MB} * 12 // 100 // ${CHATAPP_INSTANCES})))")
