#!/usr/bin/env python3
"""One-off: set TTL on Redis keys that were written without EXPIRE (prod maintenance).

Reads REDIS_URL from env file (default: CHATAPP_ENV_FILE or /opt/chatapp/shared/.env).
"""
import os
import subprocess
import urllib.parse
import sys

env_path = os.environ.get("CHATAPP_ENV_FILE", "/opt/chatapp/shared/.env")
env = {}
for line in open(env_path):
    if "=" in line:
        k, v = line.strip().split("=", 1)
        env[k] = v

url = urllib.parse.urlparse(env["REDIS_URL"])
host, port, pw = url.hostname, url.port or 6379, url.password


def cli(*args):
    return subprocess.run(
        ["redis-cli", "-h", host, "-p", str(port), "-a", pw, "--no-auth-warning"] + list(args),
        capture_output=True,
        text=True,
    )


LUA_USER = """
local c = ARGV[1]
local r = redis.call('SCAN', c, 'MATCH', 'user:last_read_count:*', 'COUNT', 800)
local next_c = r[1]
local keys = r[2]
local fixed = 0
for i = 1, #keys do
  local k = keys[i]
  if redis.call('TTL', k) == -1 then
    redis.call('EXPIRE', k, 604800)
    fixed = fixed + 1
  end
end
return next_c .. '|' .. fixed .. '|' .. #keys
"""

LUA_RS = """
local c = ARGV[1]
local r = redis.call('SCAN', c, 'MATCH', 'rs:pending:*', 'COUNT', 800)
local next_c = r[1]
local keys = r[2]
local fixed = 0
for i = 1, #keys do
  local k = keys[i]
  if redis.call('TTL', k) == -1 then
    redis.call('EXPIRE', k, 86400)
    fixed = fixed + 1
  end
end
return next_c .. '|' .. fixed .. '|' .. #keys
"""


def run_pass(name, lua):
    cursor = "0"
    total_fixed = 0
    total_seen = 0
    steps = 0
    while True:
        p = cli("EVAL", lua, "0", cursor)
        if p.returncode != 0:
            print(f"{name} EVAL error: {p.stderr}", file=sys.stderr)
            return
        parts = p.stdout.strip().split("|")
        if len(parts) != 3:
            print(f"{name} bad reply: {p.stdout!r}", file=sys.stderr)
            return
        next_c, fixed, nkeys = parts[0], int(parts[1]), int(parts[2])
        total_fixed += fixed
        total_seen += nkeys
        steps += 1
        cursor = next_c
        if cursor == "0":
            break
    print(f"{name} steps={steps} keys_seen_in_batches={total_seen} ttl_minus1_fixed={total_fixed}")


run_pass("user:last_read_count:*", LUA_USER)
run_pass("rs:pending:*", LUA_RS)
