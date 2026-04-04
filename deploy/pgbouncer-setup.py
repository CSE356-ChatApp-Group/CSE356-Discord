#!/usr/bin/env python3
"""
PgBouncer configuration script for ChatApp staging.
Run with sudo on the staging VM.

Reads /opt/chatapp/shared/.env, parses DATABASE_URL, writes pgbouncer.ini
and userlist.txt, then rewrites DATABASE_URL to point at PgBouncer (:6432).

PgBouncer is configured in transaction-pooling mode with:
  - default_pool_size = 20  (real PG backends; healthy on 2-CPU VM)
  - max_client_conn  = 1000 (virtual connections from Node instances)
  - auth_type        = trust (loopback-only; no client password needed)

This is safe because PgBouncer is bound to 127.0.0.1, and Node.js processes
run on the same VM.  The password in [databases] is used only for the
PgBouncer → PostgreSQL backend authentication.
"""

import grp
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

print(f'Parsed DATABASE_URL: user={pg_user} host={pg_host}:{pg_port} db={pg_db}')

# ── Write pgbouncer.ini ─────────────────────────────────────────────────────────
ini = f"""\
[databases]
{pg_db} = host={pg_host} port={pg_backend_port} dbname={pg_db} user={pg_user} password={pg_pass}

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

; 1000 virtual clients, 20 real PG backends — keeps PG concurrency sane on 2 CPUs.
max_client_conn     = 1000
default_pool_size   = 20
reserve_pool_size   = 5
reserve_pool_timeout = 3.0

; Timeouts (seconds)
server_connect_timeout  = 5
server_idle_timeout     = 30
query_timeout           = 20
client_idle_timeout     = 60

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

print('PgBouncer setup complete.')
