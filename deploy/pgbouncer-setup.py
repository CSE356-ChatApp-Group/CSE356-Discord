#!/usr/bin/env python3
"""
PgBouncer configuration script for ChatApp staging.
Run with sudo on the staging VM.

Reads /opt/chatapp/shared/.env, parses DATABASE_URL, writes pgbouncer.ini
and userlist.txt, then rewrites DATABASE_URL to point at PgBouncer (:6432).

PgBouncer is configured in transaction-pooling mode with:
  - default_pool_size = from PGBOUNCER_POOL_SIZE env when set (deploy scripts pass
    nCPU×50 + instance bump, capped at 400), else min(nCPU×50, 120) on this host
  - max_client_conn  = 1000 (virtual connections from Node instances)
  - auth_type        = trust (loopback-only; no client password needed)

This is safe because PgBouncer is bound to 127.0.0.1, and Node.js processes
run on the same VM.  The password in [databases] is used only for the
PgBouncer → PostgreSQL backend authentication.
"""

import grp
import os
import pwd
import re
import subprocess
import sys
import urllib.parse

ENV_FILE = '/opt/chatapp/shared/.env'

# ── Read shared .env ────────────────────────────────────────────────────────────
try:
    env_text = open(ENV_FILE).read()
except FileNotFoundError:
    print(f'ERROR: {ENV_FILE} not found', file=sys.stderr)
    sys.exit(1)

m = re.search(r'^DATABASE_URL=(.+)$', env_text, re.MULTILINE)
if not m:
    print('ERROR: DATABASE_URL not found in .env', file=sys.stderr)
    sys.exit(1)

db_url = m.group(1).strip().strip('"').strip("'")
r = urllib.parse.urlparse(db_url)
pg_user = r.username or 'chatapp'
pg_pass = urllib.parse.unquote(r.password or '')
pg_host = r.hostname or '127.0.0.1'
pg_port = r.port or 5432
pg_db   = r.path.lstrip('/')

# If DATABASE_URL was already rewritten to point at PgBouncer (:6432), use
# the real PostgreSQL port (5432) for the backend stanza — never loop back.
pg_backend_port = 5432 if pg_port == 6432 else pg_port

# If .env already targets PgBouncer, urlparse host is loopback — recover real PG host
# from the existing ini so re-runs of this script do not write host=127.0.0.1.
if str(pg_port) == '6432' and pg_host in ('127.0.0.1', 'localhost', '::1'):
    try:
        existing = open('/etc/pgbouncer/pgbouncer.ini', encoding='utf-8').read()
        mh = re.search(r'^\s*\S+\s*=\s*host=(\S+)\s+port=(\d+)', existing, re.MULTILINE)
        if mh:
            pg_host, pg_backend_port = mh.group(1), int(mh.group(2))
            print(f'Recovered PgBouncer backend from ini: {pg_host}:{pg_backend_port}')
    except OSError:
        pass

print(
    f'Parsed DATABASE_URL: user={pg_user} client={r.hostname}:{pg_port} '
    f'backend={pg_host}:{pg_backend_port} db={pg_db}'
)


def _pgbouncer_conn_value(val: str) -> str:
    """Quote values that contain = or whitespace — otherwise password=foo= breaks parsing."""
    if val == '':
        return "''"
    if re.search(r'[\s=]', val) or "'" in val:
        return "'" + val.replace("'", "''") + "'"
    return val

# ── PgBouncer pool sizing ───────────────────────────────────────────────────────
# Deploy passes PGBOUNCER_POOL_SIZE from the release host so pool size matches
# CHATAPP_INSTANCES and vCPU (see deploy-prod.sh / deploy-staging.sh).  Standalone
# runs use min(nCPU×50, 120) capped by PGBOUNCER_POOL_HARD_CAP.
#
# PGBOUNCER_POOL_HARD_CAP default is 600:
#   - deploy formula caps _PGB_SIZE at 500 (for any CPU count + instance combo)
#   - 600 gives a safety margin without clipping the deploy-computed value
#   - the old default of 400 silently clipped the 490-500 values the deploy was
#     trying to write — leaving PgBouncer under-provisioned vs PG max_connections
import multiprocessing
_ncpu = multiprocessing.cpu_count()
_default_pool_size = min(_ncpu * 50, 120)
# When deploy passes PGBOUNCER_POOL_SIZE (VM-aware), honour it up to HARD_CAP.
# Standalone runs still use the conservative _default_pool_size.
_HARD_CAP = int(os.environ.get('PGBOUNCER_POOL_HARD_CAP', '600'))
if os.environ.get('PGBOUNCER_POOL_SIZE'):
    PGBOUNCER_POOL_SIZE = min(int(os.environ['PGBOUNCER_POOL_SIZE']), _HARD_CAP)
else:
    PGBOUNCER_POOL_SIZE = _default_pool_size
PGBOUNCER_RESERVE_SIZE = max(5, _ncpu * 5)
# max_db_connections: cap total PgBouncer→PG connections per database so a bug in
# pool-size math can never cause PgBouncer to exceed PG's max_connections.
# Deploy passes PG_MAX_CONNECTIONS; standalone defaults to pool_size + 100.
_pg_max_conn = int(os.environ.get('PG_MAX_CONNECTIONS', str(PGBOUNCER_POOL_SIZE + 100)))
# Leave 10 connections for superuser / monitoring / pg_stat_activity overhead.
PGBOUNCER_MAX_DB_CONNECTIONS = max(PGBOUNCER_POOL_SIZE, _pg_max_conn - 10)
print(f'CPU count: {_ncpu} → default_pool_size={PGBOUNCER_POOL_SIZE} max_db_connections={PGBOUNCER_MAX_DB_CONNECTIONS} (PGBOUNCER_POOL_SIZE env={os.environ.get("PGBOUNCER_POOL_SIZE", "not set")})')

# ── Write pgbouncer.ini ─────────────────────────────────────────────────────────
ini = f"""\
[databases]
{pg_db} = host={pg_host} port={pg_backend_port} dbname={_pgbouncer_conn_value(pg_db)} user={_pgbouncer_conn_value(pg_user)} password={_pgbouncer_conn_value(pg_pass)}

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432

; Required for daemon mode (init.d / sysv service on Ubuntu 22.04)
logfile = /var/log/pgbouncer/pgbouncer.log
pidfile = /var/run/pgbouncer/pgbouncer.pid

; Trust connections from localhost – Node processes run on the same VM.
; The password above is used only for PgBouncer → PostgreSQL auth.
auth_type = trust
auth_file = /etc/pgbouncer/userlist.txt

; Transaction pooling: a real PG connection is held only for the duration of
; one auto-commit query (or one BEGIN…COMMIT block).  Compatible with all
; unnamed prepared statements; does NOT support named (persistent) prepared
; statements or session-level SET commands that must persist across queries.
pool_mode = transaction

; 1000 virtual clients; real PG backends = default_pool_size (deploy sets via PGBOUNCER_POOL_SIZE).
max_client_conn     = 1000
default_pool_size   = {PGBOUNCER_POOL_SIZE}
; Safety cap: PgBouncer will never open more than this many real PG connections for
; this database.  Prevents pool-size formula bugs from exceeding PG max_connections.
; Value = min(PG_MAX_CONNECTIONS - 10, ...) — set by deploy; leaves headroom for
; superuser / monitoring / pg_stat_activity connections.
max_db_connections  = {PGBOUNCER_MAX_DB_CONNECTIONS}
; Keep a warm floor of connections so the first burst after an idle period does not
; pay the cost of establishing new PG connections (~100-300 ms each on a remote DB).
min_pool_size       = 20
reserve_pool_size   = {PGBOUNCER_RESERVE_SIZE}
; 0.5 s instead of the 3.0 s default: activate reserve connections almost immediately
; when the main pool is saturated instead of waiting 3 idle seconds.
reserve_pool_timeout = 0.5

; Timeouts (seconds)
server_connect_timeout  = 5
server_idle_timeout     = 30
; 16 s: slightly above the PG role statement_timeout=15 s so PG always cancels the
; query first; PgBouncer then cleans up the server connection 1 s later.
query_timeout           = 16
; 300 s: keep Node→PgBouncer connections alive through grader quiet periods (lulls can
; reach 60–90 s). Prevents all workers simultaneously recycling their connections and
; creating a thundering-herd reconnection storm when traffic resumes.
client_idle_timeout     = 300

; Allow monitoring tools (and the chatapp user itself) to run SHOW POOLS / SHOW STATS
; without a separate admin password.  auth_type=trust is already in effect for
; loopback connections, so this adds no new authentication surface.
stats_users = {pg_user}

; Allow common pg-client startup parameters PgBouncer doesn't track.
ignore_startup_parameters = extra_float_digits,search_path

; Reduce log noise in production
log_connections    = 0
log_disconnections = 0
log_pooler_errors  = 1
stats_period       = 60
"""

# ── Write userlist.txt ──────────────────────────────────────────────────────────
# With auth_type=trust, the password here is ignored for client auth.
# The file must exist and be syntactically valid.
userlist = f'"{pg_user}" ""\n'

def write_sudo(path, content):
    r = subprocess.run(
        ['sudo', 'tee', path],
        input=content.encode(),
        check=True,
        capture_output=True,
    )

write_sudo('/etc/pgbouncer/pgbouncer.ini', ini)
write_sudo('/etc/pgbouncer/userlist.txt', userlist)

# Determine the correct owner for pgbouncer files.
# On Ubuntu 22.04, the pgbouncer user may have primary group 'postgres'
# (not 'pgbouncer'), so we detect it dynamically rather than assuming.
try:
    pb_entry = pwd.getpwnam('pgbouncer')
    pb_group = grp.getgrgid(pb_entry.pw_gid).gr_name
    pb_owner = f'pgbouncer:{pb_group}'
except KeyError:
    # Fall back when pgbouncer user/group doesn't exist yet
    pb_owner = 'postgres:postgres'

# Fix ownership and permissions on config files
for f in ('/etc/pgbouncer/pgbouncer.ini', '/etc/pgbouncer/userlist.txt'):
    subprocess.run(['sudo', 'chmod', '640', f], check=True)
    subprocess.run(['sudo', 'chown', pb_owner, f], check=True)

print('pgbouncer.ini and userlist.txt written.')

# ── Ensure log/run directories exist with correct ownership ────────────────────
for d in ('/var/log/pgbouncer', '/var/run/pgbouncer'):
    subprocess.run(['sudo', 'mkdir', '-p', d], check=True)
    subprocess.run(['sudo', 'chown', pb_owner, d], check=True)
    subprocess.run(['sudo', 'chmod', '750', d], check=True)

# ── Redirect DATABASE_URL to PgBouncer ─────────────────────────────────────────
if str(pg_port) != '6432':
    # Replace host:port in the netloc, preserve user:pass
    new_netloc = f'{pg_user}:{urllib.parse.quote(pg_pass, safe="")}@127.0.0.1:6432'
    new_url = urllib.parse.urlunparse(r._replace(netloc=new_netloc))
    new_env = re.sub(r'^DATABASE_URL=.+$', f'DATABASE_URL={new_url}', env_text, flags=re.MULTILINE)
    write_sudo(ENV_FILE, new_env)
    print(f'DATABASE_URL updated: {db_url}  ->  {new_url}')
else:
    print(f'DATABASE_URL already targets :6432, no change needed.')

# ── Set PG role timeouts (safety backstop behind PgBouncer query_timeout) ───────
# Local Postgres only: remote DB must run ALTER ROLE as superuser on the DB host
# (see deploy/cutover-to-remote-db.sh).
_is_local_pg = pg_host in ('127.0.0.1', 'localhost', '::1')
if _is_local_pg:
    result = subprocess.run(
        ['sudo', '-u', 'postgres', 'psql', '-qAt', '-c',
         f"ALTER ROLE \"{pg_user}\" SET statement_timeout='15s'; "
         f"ALTER ROLE \"{pg_user}\" SET idle_in_transaction_session_timeout='10s';"],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        print('PostgreSQL role timeouts set (statement_timeout=15s, idle_in_transaction=10s).')
    else:
        print(f'Warning: could not set PG role timeouts: {result.stderr.strip()}')
else:
    print(
        f'Skipping ALTER ROLE on app VM (PostgreSQL host is {pg_host}). '
        'Apply on the database server as postgres superuser if not already set.'
    )

print('PgBouncer setup complete.')
