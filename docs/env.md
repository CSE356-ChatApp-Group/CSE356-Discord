# Environment variables

Developer copy: [`.env.example`](../.env.example). Deploy scripts compute pool sizing on staging/production VMs (`deploy/deploy-staging.sh`, `deploy/deploy-prod.sh`).

**Deploy script (runner environment, not app `.env`):** `INGRESS_POST_DEPLOY_SECONDS` (default **20**) controls how long `deploy-prod.sh` hammers **`http://127.0.0.1/health`** through nginx after cutover. **`DEPLOY_NON_INTERACTIVE=true`** skips the production confirmation prompt (Ansible / CI); **`GITHUB_ACTIONS=true`** does the same.

**Prod monitoring VM (`/opt/chatapp-monitoring/.env`, optional):** Compose reads **`PROMETHEUS_RETENTION`**, **`PROMETHEUS_GOMEMLIMIT`** (Go heap hint for Prometheus), **`PROMETHEUS_CPU_LIMIT`**, **`LOKI_MEM_LIMIT`**, **`GRAFANA_MEM_LIMIT`**, **`TEMPO_MEM_LIMIT`**, etc. **`PROMETHEUS_MEM_LIMIT`** sets a Docker **hard memory cap** for Prometheus only if set; the repo default compose leaves it unset on the monitoring VM because prod RSS exceeded **7g** cgroup and was **memcg-OOM-killed**—prefer a **≥16 GiB** VM or a deliberate cap plus shorter retention if you must stay on **8 GiB**.

**POST `/messages` e2e trace (app workers, optional):** Set **`MESSAGE_POST_E2E_TRACE_MIN_MS`** to log **`post_messages_e2e_trace`** for successes whose wall time is at least that many milliseconds (e.g. match Grafana p99). Set **`MESSAGE_POST_E2E_TRACE_SAMPLE_RATE`** to **`0.01`** to sample ~1% of successes regardless of latency. Both can be enabled. Logs include **`requestId`**, **`worker_id`** (`hostname:PORT`), per-phase **`breakdown_ms`**, **`dominant_component`**, and **`dominant_bucket`** (`db` \| `redis` \| `serialization` \| `hydrate_db` \| `other`). Correlate with Redis **`SLOWLOG`** and Postgres **`pg_stat_statements`** using the hints in [`docs/operations-monitoring.md`](operations-monitoring.md).

**Slow non-message HTTP trace (app workers, optional):** Set **`SLOW_HTTP_TRACE_MIN_MS`** (e.g. **`2000`**) to emit **`slow_http_request_trace`** for requests whose total wall time exceeds the threshold, with **`route`**, **`requestId`**, **`worker_id`**, **`db_query_count`**, **`db_sum_ms`**, **`db_max_single_ms`**, per-query **`db_query_samples`** (truncated SQL + ms), and **`app_wall_ms_estimated`** (residual vs summed DB time; see **`db_wall_parallel_overlap_hint`** when `Promise.all` overlaps). Default **`SLOW_HTTP_TRACE_EXCLUDE_PREFIXES`** is **`/api/v1/messages,/health,/metrics`** so **`POST /messages`** stays on the dedicated message trace. See [`docs/operations-monitoring.md#slow-route-explain-workflow`](operations-monitoring.md#slow-route-explain-workflow).

**Prometheus scrape host (runner env, optional):** When rendering `infrastructure/monitoring/prometheus-host.yml` for the DB/monitoring VM, **`deploy-prod.sh`** sets the app VM address via **`PROM_APP_HOST`** if set; otherwise it uses the first address from **`hostname -I`** on the prod app SSH host, then falls back to **`10.0.0.237`**. Staging uses **`STAGING_PROM_APP_HOST`** with the same pattern, default **`10.128.0.2`**. Override when VPC addressing differs.

**Three-VM prod orchestrator (`deploy-prod-multi.sh`, runner env):** **`PROM_REDIS_HOST`** is the **private** address Prometheus uses for the `redis` scrape target (default **VM1 internal**, `10.0.0.237` in the current inventory). **`REDIS_EXPORTER_SSH_HOST`** is the **SSH-reachable** host where `redis_exporter` is started in Docker (default **VM1 public**, `130.245.136.44`). Do not point SSH at a VPC-only IP from a machine outside the VLAN — the old default did that and caused deploy-time SSH timeouts while metrics checks still passed.

## Grading / autograder hosts

If the VM is **only** hit by course autograders (no general public) and you do not care about auth brute-force or spam, you can still opt into a grading profile by setting **`DISABLE_RATE_LIMITS=true`** (and optionally **`AUTH_REGISTER_GLOBAL_PER_IP_MAX`**) in `/opt/chatapp/shared/.env` **after** deploy — note that **`deploy/env/*.required.env`** now pins **`DISABLE_RATE_LIMITS=false`** on each deploy so public-facing hosts keep Redis-backed auth limits unless you override deliberately.

For a **pure grader-only** host, operators historically pinned:

1. **`DISABLE_RATE_LIMITS=true`** — removes throttling on register, login, OAuth connect, and the optional **`POST /api/v1/rum`** limiter.
2. **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=false`** — avoids extra 429s for many bot users behind one source IP on **login**.
3. **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`** and **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=true`** — keep logical-user delivery inline before **201** so connected community members do not depend on per-channel websocket maps.
4. **`WS_AUTO_SUBSCRIBE_MODE=user_only`**, **`USER_FEED_SHARD_COUNT=64`**, and **`WS_RECENT_CONNECT_TTL_SECONDS=300`** — keep public-channel delivery on the durable user/community feed path and out of stale per-channel websocket maps while preserving a longer reconnect bridge window.
5. **`WS_APP_KEEPALIVE_INTERVAL_MS=10000`** — sends a tiny app-level keepalive frame on otherwise-idle sockets every 10s. This is a conservative hedge for grader/network paths that appear to churn idle WebSocket upgrades on ~30s boundaries even when control ping/pong is enabled.

Those settings prioritize grader throughput on trusted bot traffic while still preserving the reconnect bridge. If you later run the same deploy scripts against a public-facing host, override them deliberately.

**POST `/api/v1/messages`:** **201** includes explicit realtime fields — not one ambiguous “complete” flag. **Channel** posts: `realtimeChannelFanoutComplete: true` after the `channel:<uuid>` Redis publish; `realtimeUserFanoutDeferred: true|false` states whether logical per-member user delivery finished before **201** (`MESSAGE_USER_FANOUT_HTTP_BLOCKING`). Those logical user publishes are routed through sharded Redis channels (`userfeed:<n>`) and delivered to WebSocket clients as **`user:<id>`** events. **Conversation/DM** posts: `realtimeConversationFanoutComplete: true`. End-to-end browser delivery is still asynchronous; graders often allow **~15s** per listener.

## Auth bursts without extra 429s

If you **do not** want **`AUTH_GLOBAL_PER_IP_RATE_LIMIT`** (or you keep **`DISABLE_RATE_LIMITS=true`** on graders), overload shows up as **long latency** and **nginx 502/504**, not JSON 429 from that feature. Mitigations are **capacity and timeouts**, not more silent queueing on one small VM:

1. **More API processes** — e.g. **`CHATAPP_INSTANCES=4`** on the current prod layout (or another value that matches host capacity), with nginx balancing the configured worker ports when the host has **enough CPU and RAM** (each Node heap is sized in deploy scripts).
2. **Larger or additional VMs** — horizontal scale + connection pool tuning (Postgres / PgBouncer).
3. **`BCRYPT_MAX_CONCURRENT`** / **`BCRYPT_ROUNDS`** — default **`BCRYPT_ROUNDS=1`** (lowest configured cost; bcrypt still uses at least cost **4** in the hash). When **`BCRYPT_MAX_CONCURRENT`** is unset, code derives a threadpool-aware default from **`UV_THREADPOOL_SIZE`** and host CPU count; deploy scripts still pin an explicit per-instance value so auth burst queueing stays visible in app metrics instead of disappearing into libuv backlog. Raising rounds or concurrency increases parallel CPU load.
4. **Nginx `proxy_read_timeout` on `/api/v1/auth/`** — already raised in repo templates (**75s**) so fewer **504 HTML** pages while upstream is slow; clients still wait longer.

There is no way to accept **unlimited** simultaneous bcrypt-heavy logins on **finite** hardware with bounded latency; the choice is **where** overload appears (app JSON vs nginx HTML vs long waits).

## Production shared `.env` audit (real-user deployments)

On the production host, inspect `/opt/chatapp/shared/.env` (used by systemd `chatapp@` units). **SSH access is required; this checklist is not runnable from CI.**

1. **`DISABLE_RATE_LIMITS`** should **not** be `true` when the app faces untrusted traffic. If set, auth route rate limiting is disabled (register, login, oauth-connect) and the optional RUM limiter is disabled. **Grading-only hosts are an exception** — see above.
2. **`AUTH_REGISTER_RATE_LIMIT_MAX`**, **`AUTH_LOGIN_RATE_LIMIT_MAX`**, **`AUTH_CONNECT_RATE_LIMIT_MAX`** — only set if you intentionally override [defaults in `backend/src/auth/router.ts`](../backend/src/auth/router.ts) (register 20 / 10 min per credential, login 60 / 1 min, connect 30 / 5 min). **`AUTH_REGISTER_GLOBAL_PER_IP_*`** caps **all** registrations from one client IP (always on except `DISABLE_RATE_LIMITS` / test). **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`** adds the same style of cap for **login** only; leave unset/false if you prefer not to deny logins on that axis (then add **capacity** instead — see below).
3. **Window overrides** (`AUTH_*_RATE_LIMIT_WINDOW_MS`) — same as above; omit unless tuning.
4. **`OVERLOAD_HTTP_SHED_ENABLED`** — both **`deploy-staging.sh`** and **`deploy-prod.sh`** pin **`false`** (staging used to enable shedding and graders saw JSON **503** under normal lag). Turn **`true`** only if you deliberately want fail-fast shedding.
5. **`AUTH_BYPASS`** — should **not** be `true` when grading real authentication behavior (use `false` for real-user prod). **`deploy-prod.sh`** forces **`AUTH_BYPASS=false`** and **`NODE_ENV=production`** on every deploy.
6. **`NODE_ENV`** — should be **`production`** on the API host; **`deploy-prod.sh`** enforces it.
7. **`OVERLOAD_LAG_SHED_MS`** — **`deploy-prod.sh`** sets **`250`** (matches code default when HTTP shedding is enabled). **`OVERLOAD_HTTP_SHED_ENABLED`** remains **`false`** on prod unless you opt in.

**Repository audit (no server access):** [`docker-compose.yml`](../docker-compose.yml) sets high register/login limits (500) **only** for the local `api` service to support parallel E2E; production does not use that compose stack as-is. Channel **`message:created`** logical user fanout is **on by default in code**; [`deploy/deploy-staging.sh`](../deploy/deploy-staging.sh) / [`deploy/deploy-prod.sh`](../deploy/deploy-prod.sh) tee grading-oriented defaults, then **`apply-env-profile.py`** merges [`deploy/env/staging.required.env`](../deploy/env/staging.required.env) / [`deploy/env/prod.required.env`](../deploy/env/prod.required.env), which pins **`DISABLE_RATE_LIMITS=false`** so Redis-backed auth limiters (including per-IP registration) stay on. Shell blocks still set **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=false`** (login-only optional per-IP), **`AUTH_PASSWORD_STORAGE_MODE=plain`**, **`CHANNEL_MESSAGE_USER_FANOUT=true`**, **`CHANNEL_MESSAGE_USER_FANOUT_MODE=all`**, **`CHANNEL_MESSAGE_USER_FANOUT_MAX=10000`**, **`CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS=180`**, **`CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS=180`**, **`MESSAGE_USER_FANOUT_HTTP_BLOCKING=true`**, **`WS_AUTO_SUBSCRIBE_MODE=user_only`**, **`WS_APP_KEEPALIVE_INTERVAL_MS=10000`**, **`USER_FEED_SHARD_COUNT=64`**, **`WS_RECENT_CONNECT_TTL_SECONDS=300`**, **`WS_BOOTSTRAP_BATCH_SIZE=64`**, **`WS_BOOTSTRAP_CACHE_TTL_SECONDS=180`**, **`COMMUNITIES_LIST_CACHE_TTL_SECS=300`**, and **`CHANNELS_LIST_CACHE_TTL_SECS=300`**, plus **`OVERLOAD_HTTP_SHED_ENABLED=false`** and **`OVERLOAD_LAG_SHED_MS=250`**, and prod-only **`NODE_ENV=production`** and **`AUTH_BYPASS=false`** (see `deploy-staging.sh` / `deploy-prod.sh`).

## Backend API (`backend/src`) — optional tunables

All have defaults in code unless noted. Omit in `.env` for normal operation.

| Variable | Purpose |
|----------|---------|
| **Core** | |
| `NODE_ENV` | `development` / `production` |
| `PORT` | HTTP port |
| `LOG_LEVEL` | Pino level (production default `info`) |
| `LOG_SERVICE_NAME` | Service name in logs / tracing |
| `HTTP_COMPRESSION_ENABLED` | Enable Express gzip compression. Default on outside production, off in production because repo nginx already gzips API responses. |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Signing secrets |
| `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL` | Token lifetimes |
| `JWT_ACCESS_VERIFY_CACHE_TTL_MS` | Access-token verify cache TTL (default 15000) |
| `JWT_DENYLIST_CHECK_CACHE_TTL_MS` | Denylist check cache TTL (default 15000) |
| `JWT_TOKEN_CACHE_MAX_ENTRIES` | Max cached token entries (default 5000) |
| `FRONTEND_URL`, `CORS_ORIGIN` | Browser origin / redirects |
| `COOKIE_SECURE` | Force `Secure` on refresh cookie (`true`/`false`) |
| **Auth / dev** | |
| `AUTH_BYPASS` | `true` enables dev bypass (never in prod) |
| `AUTH_BYPASS_USER_ID`, `AUTH_BYPASS_USER_EMAIL`, `AUTH_BYPASS_USER_USERNAME`, `AUTH_BYPASS_USER_DISPLAY_NAME` | Bypass user profile |
| `DISABLE_RATE_LIMITS` | `true` disables auth rate limits, community join limits, and (when RUM is enabled) `POST /api/v1/rum` limits; use only on isolated grading hosts if desired |
| `AUTO_IP_BAN_ENABLED` | Explicit `true` / `false` overrides defaults: when **unset**, bans are **on** in `NODE_ENV=production` and **off** in `NODE_ENV=test`. Set `true` in required env on staging/prod (`deploy/env/*.required.env`). Set `false` if `X-Real-IP` is untrusted. Strikes: `AUTO_IP_BAN_STRIKES` (default 40), `AUTO_IP_BAN_STRIKE_WINDOW_SEC` (120), `AUTO_IP_BAN_TTL_SEC` (900). Internal/private IPs (RFC1918, loopback, ULA, 100.64/10) are never banned or strike-counted. |
| `AUTH_REGISTER_RATE_LIMIT_MAX`, `AUTH_REGISTER_RATE_LIMIT_WINDOW_MS` | Register limiter (per IP + credential — each username/email bucket) |
| `AUTH_GLOBAL_PER_IP_RATE_LIMIT` | Set to `true` to enable **login** global per-IP 429 (`AUTH_LOGIN_GLOBAL_PER_IP_*`); **default off** |
| `AUTH_REGISTER_GLOBAL_PER_IP_MAX`, `AUTH_REGISTER_GLOBAL_PER_IP_WINDOW_MS` | Register cap **per client IP** across all usernames (always on unless `DISABLE_RATE_LIMITS` or `NODE_ENV=test`) |
| `AUTH_LOGIN_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` | Login limiter (per IP + credential) |
| `AUTH_LOGIN_GLOBAL_PER_IP_MAX`, `AUTH_LOGIN_GLOBAL_PER_IP_WINDOW_MS` | Login cap per client IP (only when `AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`; **skipped when `NODE_ENV=test`**) |
| `AUTH_CONNECT_RATE_LIMIT_MAX`, `AUTH_CONNECT_RATE_LIMIT_WINDOW_MS` | OAuth connect-existing limiter |
| `COMMUNITY_JOIN_PER_IP_MAX`, `COMMUNITY_JOIN_PER_IP_WINDOW_MS` | Redis-backed cap for `POST /communities/:id/join` per client IP (deploy default: `300` per `60000` ms; skipped for internal IPs, `DISABLE_RATE_LIMITS`, and tests) |
| `COMMUNITY_JOIN_PER_USER_MAX`, `COMMUNITY_JOIN_PER_USER_WINDOW_MS` | Redis-backed cap for `POST /communities/:id/join` per authenticated user (deploy default: `120` per `60000` ms; skipped for internal IPs, `DISABLE_RATE_LIMITS`, and tests) |
| `OAUTH_PENDING_SECRET`, `OAUTH_LINK_SECRET` | OAuth state tokens (fallback: JWT secrets) |
| `BCRYPT_MAX_CONCURRENT`, `BCRYPT_MAX_WAITERS`, `BCRYPT_QUEUE_WAIT_TIMEOUT_MS` | Password hashing queue; watch `auth_bcrypt_active`, `auth_bcrypt_waiters`, and `auth_bcrypt_queue_rejects_total` |
| `BCRYPT_ROUNDS` | bcrypt cost (default **1**; bcrypt raises configured costs **1–3** to **4** in the stored hash) |
| `AUTH_PASSWORD_STORAGE_MODE` | `bcrypt` (default) or `plain` (throughput-first, insecure). In `plain`, new/updated passwords are stored as a non-bcrypt prefixed value while existing bcrypt hashes still validate normally. |
| **OAuth providers** | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` | GitHub OAuth |
| `COURSE_OIDC_DISCOVERY_URL`, `COURSE_OIDC_CLIENT_ID`, `COURSE_OIDC_CLIENT_SECRET`, `COURSE_OIDC_CALLBACK_URL` | Course OIDC |
| **Postgres pool** | |
| `PG_POOL_MAX`, `POOL_CIRCUIT_BREAKER_QUEUE` | Pool size and circuit-breaker queue |
| `PG_SLOW_QUERY_MS`, `PG_CONNECTION_TIMEOUT_MS`, `PG_IDLE_TIMEOUT_MS` | Pool behavior |
| `READ_RECEIPT_DEFER_POOL_WAITING` | Soft-defer `PUT /messages/:id/read` when pool waiters reach this threshold (default 8) to protect message-post and read/list latency under burst |
| `MESSAGE_INSERT_LOCK_PRESSURE_WINDOW_MS` | Rolling window (ms) for in-process channel insert lock wait samples and timeout markers used for read-receipt shedding (default **30000**, clamped **5000–120000**) |
| `MESSAGE_INSERT_LOCK_MODE` | `serialized` (default): Redis + in-process queue serialize channel `POST /messages` inserts per `channel_id` to reduce hot btree/GIN page contention. `optimistic` (aliases **`off`**, **`false`**, **`none`**): skip that lock entirely; inserts run concurrently. Counted in `message_channel_insert_lock_total{result="optimistic_bypass"}`. Per-path breakdown: `message_channel_insert_path_total` / `message_channel_insert_path_precall_ms` (see `docs/operations-monitoring.md`). |
| `MESSAGE_INSERT_LOCK_PATH_LOG` | When **`1`** / **`true`** / **`yes`**, log structured `message_channel_insert_path` for **every** channel insert at sample rate **1.0** (high volume; use only for short proof runs). |
| `MESSAGE_INSERT_LOCK_PATH_LOG_SAMPLE_RATE` | Fraction **0–1** of channel `POST /messages` inserts that emit `message_channel_insert_path` logs when `MESSAGE_INSERT_LOCK_PATH_LOG` is not enabled (default **0**). |
| `MESSAGE_INSERT_LOCK_ENABLED` | When **`false`** / **`0`** / **`off`** / **`no`**, same bypass as `MESSAGE_INSERT_LOCK_MODE=optimistic`. When unset, inserts use the serialized lock (unless `MESSAGE_INSERT_LOCK_MODE` requests bypass). |
| `MESSAGE_INSERT_LOCK_TTL_MS` | Redis NX lock TTL for per-channel `POST /messages` serialization (default **45000**, clamped **5000–120000**). Must cover slow commits under DB I/O pressure; too low causes `release_mismatch` when the lock expires mid-transaction. |
| `MESSAGE_INSERT_LOCK_WAIT_TIMEOUT_MS` | Max time to wait for the Redis insert lock before `503` on `POST /messages` (default **2000**, clamped **500–4000**). |
| `MESSAGE_INSERT_LOCK_REDIS_OP_TIMEOUT_MS` | Per-op wall-clock cap for Redis `SET NX` / `EVAL` used by the insert lock (default **250**, clamped **25–2000**). Under Redis load spikes, raising this reduces false `REDIS_OP_TIMEOUT` on acquire/release at the cost of slower failure when Redis is truly stuck. |
| `MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_WINDOW_MS` | Window (ms) for “recent insert-lock timeout” backoff on hot channels (default **2000**, clamped **250–10000**). |
| `MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MIN_MS` / `MESSAGE_INSERT_LOCK_RECENT_TIMEOUT_BACKOFF_MAX_MS` | Jittered backoff bounds (ms) after a recent timeout in that window (defaults **200** / **500**). |
| `MESSAGE_INSERT_LOCK_MAX_WAITERS_PER_CHANNEL` | Per-process cap for concurrent waiters on a single channel insert lock (default **32**, clamped **1–1000**). Requests beyond this cap fail fast with `503` to avoid unbounded queueing. |
| `READ_SHED_MESSAGE_INSERT_LOCK_WAIT_P95_MS` | When successful insert-lock waits in the window reach this **p95** (ms), soft-defer `PUT /messages/:id/read` (default **320**, clamped **200–500**). Also defers if **any** lock timeout occurred in the window, or **≥4** samples include any wait **≥380ms** |
| `READ_SHED_MESSAGE_INSERT_LOCK_MIN_SAMPLES_FOR_P95` | Minimum acquire samples in the window before the p95 rule can trigger (default **6**, max **100**); timeout-in-window always triggers alone |
| **Overload / degradation** | |
| `OVERLOAD_RSS_WARN_MB`, `OVERLOAD_RSS_HIGH_MB`, `OVERLOAD_RSS_CRITICAL_MB` | RSS thresholds (MB) |
| `OVERLOAD_LAG_WARN_MS`, `OVERLOAD_LAG_HIGH_MS`, `OVERLOAD_LAG_CRITICAL_MS` | Event-loop p99 lag (ms) |
| `FORCE_OVERLOAD_STAGE` | Force stage 0–3 (testing) |
| `OVERLOAD_HTTP_SHED_ENABLED` | `true` to return 503 when lag ≥ `OVERLOAD_LAG_SHED_MS` |
| `OVERLOAD_LAG_SHED_MS` | Lag threshold for HTTP shed (default 250) |
| **Redis / messages** | |
| `REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS` | Retries for channel publish (default 4) |
| `MSG_IDEM_PENDING_TTL_SECS`, `MSG_IDEM_SUCCESS_TTL_SECS` | POST /messages idempotency TTLs |
| `MSG_IDEM_POLL_DEADLINE_MS` | Max wall-clock wait when a second POST shares `Idempotency-Key` while the first holds the Redis lease (default **5000**, clamped 500–30000). Replaces legacy fixed **100ms × 50** polling. |
| `MSG_IDEM_POLL_MAX_SLEEP_MS` | Exponential backoff cap between Redis polls in that wait loop (default **150**, clamped 5–500). |
| `FANOUT_QUEUE_CONCURRENCY`, `FANOUT_CRITICAL_MAX_DEPTH` | Side-effect / fanout queue |
| `FANOUT_QUEUE_YIELD_EVERY` | Fanout worker yields to the event loop after this many completed jobs when more work remains (default **6**; set **`0`** to disable). Reduces coordinated long turns under burst. |
| **S3** | |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_INTERNAL_ENDPOINT` | Bucket and endpoints |
| `S3_PRESIGN_SIGNING_ENDPOINT` | Presign signing host when public URL differs |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Credentials |
| **HTTP / caches** | |
| `COMMUNITIES_LIST_CACHE_TTL_SECS`, `CHANNELS_LIST_CACHE_TTL_SECS`, `COMMUNITIES_VERSION_CACHE_TTL_SECS` | List route cache TTLs (deploy default list `300`; version-key TTL default **2592000** so `communities:list:user_version:*` / `communities:list:public_version` do not accumulate forever) |
| `COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS`, `COMMUNITIES_HEAVY_QUERY_MAX_INFLIGHT` | `GET /communities` unread-count hydration timeout plus concurrency cap before serving the normal base list with `unread_channel_count=0`; watch route p95 and `endpoint_list_cache_bypass_total{endpoint="communities",reason=~"pressure|timeout"}` |
| `CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST` | When `true` (default), `message:created` is published to `channel:<uuid>` before logical per-member user delivery |
| `CHANNEL_MESSAGE_USER_FANOUT_MODE` | `all` (code default) duplicates channel `message:created` to every visible member for the most conservative delivery semantics. Staging/prod deploy profiles currently pin `recent_connect` as a throughput-first tradeoff on controlled grader hosts that can tolerate channel-only delivery after the reconnect bridge expires. |
| `CHANNEL_MESSAGE_USER_FANOUT_MAX` | Max per-message logical user duplicate deliveries (default **10000**, cap **10000**). Members beyond this rely on **`channel:`** delivery only — intentional for mega-channels; clients must listen on `channel:` or accept missing user-scope delivery. |
| `COMMUNITY_FEED_SHARD_COUNT` | Number of sharded Redis pub/sub channels used for server-side community membership delivery. Public channel messages are also published to the owning community feed so connected community members receive notifications without stale per-channel recipient caches. Default/prod **64**. |
| `CHANNEL_USER_FANOUT_TARGETS_CACHE_TTL_SECS` | Redis TTL for cached per-channel user fanout audiences used by channel message publishes (default `180`) |
| `CONVERSATION_FANOUT_TARGETS_CACHE_TTL_SECS` | Redis TTL for cached conversation participant fanout audiences used by DM/group-DM realtime publishes (default `180`) |
| `MESSAGE_USER_FANOUT_HTTP_BLOCKING` | When `true`, `POST /messages` awaits all logical user fanout Redis publishes before **201** (`realtimeUserFanoutDeferred: false`). When `false`, only recent-connect members are published inline; remaining members are deferred to `fanout:critical`, which can miss the grader **~15s** window under burst load. Staging/prod deploy profiles pin **`true`** for delivery reliability. |
| `MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS` | Per-transaction `SET LOCAL statement_timeout` for the **POST /messages** insert CTE only (default **5000** ms, clamped **1000–60000**). Fails before PgBouncer/role caps so hot-channel lock waits return **503** + `Retry-After: 1` instead of holding a client for ~15–18s and surfacing as **500**. |
| `MESSAGE_POST_CHANNEL_INSERT_STATEMENT_TIMEOUT_MS` | Optional channel-only override for POST `/messages` insert/attachment `SET LOCAL statement_timeout` (defaults to `MESSAGE_POST_INSERT_STATEMENT_TIMEOUT_MS`, then **6500** ms; clamped **1000–60000**). Lets channel paths tolerate slightly longer lock contention without changing DM insert timeout behavior. |
| `MESSAGE_POST_CACHE_BUST_TIMEOUT_MS` | Wall-clock cap (ms) for **post-commit message list cache bust** (`DEL` of list cache keys) on `POST /messages` only (default **350**, clamped **50–2000**). On timeout, **`delivery_timeout_total{phase="cache_bust"}`** increments and the handler still returns **201** — the message row is durable; clients should tolerate brief list-cache staleness or use read-your-writes / replay. |
| `MESSAGE_POST_IMMEDIATE_RECENT_BRIDGE_ENABLED` | When `true`, async channel POST `/messages` performs a bounded immediate publish to very recent channel users before queueing full fanout. Default **false** to avoid duplicate user-topic publish overhead on hot channels. |
| `MESSAGE_POST_RECENT_BRIDGE_TIMEOUT_MS` | Wall-clock cap (ms) for the immediate recent-connect bridge when enabled (default **125**, clamped **25–1000**). Timeout increments **`delivery_timeout_total{phase="recent_bridge"}`** and still returns **201**. |
| `POST_INSERT_REDIS_WORK_TIMEOUT_MS` | **Legacy alias** for `MESSAGE_POST_CACHE_BUST_TIMEOUT_MS` when the latter is unset. Fanout **`PUBLISH`** no longer uses this budget (async default, or uncapped await in sync mode). |
| `MESSAGE_POST_SYNC_FANOUT` | Set **`1`/`true`** to restore **pre-async** behavior: **`await`** **`publishChannelMessageCreated` / `publishConversationEventNow`** on the request thread (no wall-clock race — slow Redis can extend POST latency but does not flip **`realtime*Complete`** via timeout). Default (unset) defers to **`enqueueFanoutJob`** + **`messagePostFanoutAsync`** (dedupe, retries, dead-letter). |
| `MESSAGE_FANOUT_JOB_LOCK_TTL_SEC` | Redis lock TTL for in-flight post-message fanout job per `messageId` (default **300**, clamped **60–900**). |
| `MESSAGE_FANOUT_JOB_DONE_TTL_SEC` | Redis “fanout completed” marker TTL (default **7200** s, clamped **3600–604800**) so duplicate jobs skip **`PUBLISH`** while limiting marker growth under sustained traffic. |
| `MESSAGE_FANOUT_JOB_MAX_ATTEMPTS` | Publish attempts per job before dead-letter (default **5**, clamped **1–10**). |
| `MESSAGE_FANOUT_JOB_BACKOFF_MS_BASE` | Exponential backoff base (ms) between attempts (default **100**, clamped **25–2000**). |
| `REDIS_FANOUT_RETRY_INFO_SAMPLE_RATE` | Samples "fanout publish succeeded after retry" info logs in `websocket/fanout` (`0..1`, default `0`). Retry/failure warnings remain unsampled. |
| `MESSAGE_INGEST_STREAM_ENABLED`, `MESSAGE_INGEST_STREAM_CONSUMER` | `1`/`true` to append channel message metadata to Redis Stream `MESSAGE_INGEST_STREAM_KEY` and run an ACK consumer (pipeline hook before Kafka/NATS) |
| `READ_RECEIPT_SAME_MESSAGE_COALESCE_MS` | In-memory coalescing window for repeated `PUT /messages/:id/read` calls for the same `(user,message)` (default **400ms**, clamp **100–2000**). Skips duplicate hot-path work when clients spam identical reads. |
| `READ_RECEIPT_SCOPE_CURSOR_CACHE_TTL_MS` | Short-lived in-process `(user,channel|conversation)` cursor cache window for `PUT /messages/:id/read` (default **500ms**, clamp **250–5000**). Skips duplicate reads when message cursor is already known ahead in the same hot burst. |
| `READ_RECEIPT_SCOPE_DEBOUNCE_MS` | Per `(user,channel|conversation)` burst debounce window for `PUT /messages/:id/read` (default **900ms**, clamp **250–2000**). Within the window, only the highest cursor message is processed; older duplicates return immediately. |
| `READ_RECEIPT_FANOUT_ENABLED` | Enables `read:updated` fanout publishes from `PUT /messages/:id/read`. Default **`true`** so realtime read receipts work out of the box; set to `false` only if you intentionally want durable read-state updates without websocket fanout. |
| `READ_RECEIPT_CHANNEL_FANOUT_ASYNC` | When **`true`** (default), **channel** `read:updated` fanout runs on **`fanout:critical`** (does not extend **`PUT /read`** wall time). **Conversation/DM** reads still publish inline. If the fanout queue refuses the job, publish runs on-thread as fallback. |
| `MESSAGE_INGEST_STREAM_KEY`, `MESSAGE_INGEST_STREAM_GROUP`, `MESSAGE_INGEST_STREAM_MAXLEN` | Stream name, consumer group, approximate max stream length |
| `LAST_MESSAGE_PG_RECONCILE_ENABLED` | `true` to enable background DB reconcile of `channels.last_message_*` from Redis metadata **and** delete-time `repointChannelLastMessage` DB updates; default `false` keeps channel latest-message metadata Redis-first with DB as stale fallback |
| `CHANNEL_LAST_MESSAGE_PG_RECONCILE_ENABLED` | Legacy alias for `LAST_MESSAGE_PG_RECONCILE_ENABLED` (either may be set; **`LAST_MESSAGE_*` wins** when both are present) |
| `CONVERSATION_LAST_MESSAGE_PG_RECONCILE_ENABLED` | `true` to enable background DB reconcile of `conversations.last_message_*` from Redis metadata **and** delete-time `repointConversationLastMessage` DB updates; default `false` keeps conversation latest-message metadata Redis-first with DB as stale fallback |
| `LAST_MESSAGE_REDIS_TTL_SECS` | TTL for Redis metadata keys `ch:last_msg:*` / `conv:last_msg:*` (default **43200** s) so these recoverable caches do not remain immortal. |
| `PG_READ_REPLICA_URL`, `PG_READ_POOL_MAX` | Optional read replica for `GET /api/v1/messages` list `SELECT`s ([`docs/db-scaling-messages.md`](db-scaling-messages.md)). Request **`X-ChatApp-Read-Consistency: primary`** on that GET to force the primary when you need read-your-writes after a POST. |
| `PG_READ_FALLBACK_TO_PRIMARY` | When **`false`**, `queryRead()` fails fast on replica errors. Otherwise (default) **transport** failures and replica query timeouts retry the same SELECT on the primary so routes like **`PUT /messages/:id/read`** do not return **500** if the standby is down or wedged. |
| `PG_READ_QUERY_TIMEOUT_MS` | Optional read-replica query timeout in milliseconds. When set above `0`, a slow replica SELECT times out and, if `PG_READ_FALLBACK_TO_PRIMARY` is enabled, retries on primary. Prod currently pins **`750`** during incident stabilization. |
| `UNREAD_COUNTS_QUERY_TIMEOUT_MS` | Read-replica query timeout for `GET /api/v1/unread-counts` aggregate channel/DM unread counts. Default **750** ms; falls back through `queryRead()` if the replica times out and primary fallback is enabled. |
| `PRESENCE_FANOUT_CACHE_TTL_SECONDS` | Presence fanout cache |
| **WebSocket** | |
| `REALTIME_EVENT_ALIAS_FANOUT` | When **`1`/`true`/`yes`**, `fanout.publish` / `fanout.publishBatch` (including sharded userfeed batches) also publishes **alias** event names on the same Redis channel — for example `new_message` beside `message:created`, `message:edited` / `message_edited` beside `message:updated`, and read-receipt aliases beside `read:updated`. Default **off**. **Not required** for the in-repo grader `GeneratedClient` (see [`docs/websocket-generated-client-parity.md`](websocket-generated-client-parity.md)); enable only for third-party harnesses that insist on alternate names. When on, permissive clients may invoke handlers twice. **Canonical + alias tables and WS “reliable event” classification** live in [`backend/src/realtime/realtimeEventAliases.ts`](../backend/src/realtime/realtimeEventAliases.ts) (one file to edit when adding names). |
| `WS_BACKPRESSURE_DROP_BYTES`, `WS_BACKPRESSURE_KILL_BYTES` | Backpressure thresholds |
| `WS_OUTBOUND_QUEUE_MAX_MESSAGE`, `WS_OUTBOUND_QUEUE_MAX_BEST_EFFORT`, `WS_OUTBOUND_DRAIN_BATCH` | Per-socket outbound queue caps and max `ws.send` calls per `setImmediate` drain tick |
| `WS_REPLAY_OUTBOUND_YIELD_EVERY` | After enqueueing this many replay frames on one socket (pending queue + DB missed replay), **`setImmediate`** yield before continuing (default **48**, clamp **8–512**). |
| `WS_OUTBOUND_MESSAGE_WAITERS_MAX` | When the primary queue is full, `message:*` frames wait in a FIFO (default **4096**); exceeding this closes the socket (`outbound_waiters_overflow`) |
| `WS_HOT_LOG_SAMPLE_RATE` | Samples high-frequency websocket info logs (`connected`, `disconnected`, replay progress). `0` disables these info logs, `1` logs all (default `0`). Warnings/errors are unaffected. |
| `WS_ACL_CACHE_MAX_ENTRIES`, `WS_BOOTSTRAP_BATCH_SIZE`, `WS_BOOTSTRAP_CACHE_TTL_SECONDS`, `WS_RECENT_CONNECT_TTL_SECONDS` | WS tuning (code default recent-connect bridge window `20`; staging/prod deploy profiles pin bootstrap TTL `180`, batch size `64`, and recent-connect bridge window `300`) |
| `WS_AUTO_SUBSCRIBE_MODE` | `messages` subscribes **`channel:`** + **`conversation:`** + **`user:<self>`** during connect; `user_only` keeps **`user:<self>`** plus sharded community-feed membership so public-channel notifications still arrive without per-channel subscriptions. Prod pins **`user_only`** to avoid stale per-channel websocket maps on grader reconnect churn. `full` also eager-subscribes accessible **`community:`** topics. |
| `WS_APP_KEEPALIVE_INTERVAL_MS` | When `>=5000`, sends a tiny `{"event":"keepalive"}` data frame to otherwise-idle sockets on that cadence. Leave `0` to disable. Useful when intermediaries churn idle WebSocket upgrades despite normal control ping/pong. |
| `WS_HEARTBEAT_INTERVAL_MS` | Server `ws.ping()` cadence for liveness (default **20000** ms, minimum **5000**). Each interval marks sockets dead if no `pong` was processed since the last tick — under heavy CPU/event-loop lag, **too low** a value can cause **`heartbeat_timeout` (1006)** closes. Staging/prod profiles pin **30000** ms as a grading-oriented hedge. |
| `WS_REPLAY_DEDUP_TTL_SEC` | Redis key `ws:replay:recent:<userId>` TTL (**2–5** seconds, default **3**) suppressing a second identical reconnect-replay DB scan (same replay window fingerprint). Fail-open if Redis errors. |
| `WS_REPLAY_PENDING_USER_MAX_ZSET` | Max cardinality for each `ws:pending:user:*` ZSET (default **400**, clamp **50–5000**). Enqueue trims oldest entries beyond the cap and refreshes TTL. |
| `WS_REPLAY_PENDING_MEMORY_GUARD_ENABLED`, `WS_REPLAY_PENDING_MEMORY_GUARD_PCT` | Emergency guard for nonessential pending replay writes (defaults `true`, **85%**). When Redis memory usage exceeds threshold, enqueue skips `ws:pending:*` writes (DB durability/idempotency unaffected) and increments `ws_pending_replay_guard_total`. |
| `WS_REPLAY_PENDING_ONLY_ACTIVE` | When **`true`** (default), `ws:pending:user:*` is written only for users with **`user:<id>:connections`** (active WS on any worker) or a short recent-session marker (`ws:recent_connect:*` / `ws:replay_pending_eligible:*`). Fully offline members are skipped (they still see history via Postgres + reconnect DB replay). Set **`false`** to enqueue pending pointers for every fanout target (legacy, higher Redis cardinality). |
| `WS_REPLAY_PENDING_LEGACY_ALL` | When **`true`**, forces legacy behavior: enqueue pending for **all** fanout targets regardless of `WS_REPLAY_PENDING_ONLY_ACTIVE` (emergency rollback). Default **`false`**. |
| `WS_PENDING_ELIGIBLE_LEGACY_FALLBACK` | When **`true`**, pending replay classification runs a **second** Redis pipeline (`EXISTS` on `ws:recent_connect:*` / `ws:replay_pending_eligible:*`) only for users who missed `ws:pending_eligible:*` in phase 1 with zero connections — use during rollout before every session has `ws:pending_eligible:*`. **Production profile pins `false`** after stabilization to maximize Redis savings. Code default remains **`true`** if unset (safe first boot). |
| `WS_PENDING_ELIGIBLE_CONVERSATION_MARKER_FALLBACK` | When **`true`** (default) and **`WS_PENDING_ELIGIBLE_LEGACY_FALLBACK=false`**, DM / other callers that **omit** `recentTargets` still get the second `EXISTS` pass on `ws:recent_connect:*` / `ws:replay_pending_eligible:*` for phase‑1 misses. Channel **`message:created`** passes `recentTargets` explicitly and avoids this extra Redis work at large N. Set **`false`** only when debugging classification cost on small DM traffic. **Metric:** `pending_replay_second_probe_recent_user_total{mode="conversation_marker"|"legacy_global"}` counts users rescued by that second probe. **Replay vs channel/DM:** use `ws_reliable_delivery_topic_total{path="replay",topic_prefix="conversation"|"channel"|"user"}` (existing series). |
| `WS_REPLAY_RECENT_USER_WINDOW_SECONDS` | TTL for `ws:replay_pending_eligible:<userId>` refreshed on each WebSocket connect (**5–600**, default **30**). Set **`0`** to stop writing that key (recent branch then uses only `ws:recent_connect:*`). |
| `WS_MESSAGE_REPLAY_LIMIT`, `WS_MESSAGE_REPLAY_MAX_WINDOW_MS`, `WS_MESSAGE_REPLAY_DISCONNECT_GRACE_MS` | Reconnect replay scan bounds (defaults **150** rows, **60000** ms window, **15000** ms grace before `disconnectedAt`). Set **`WS_MESSAGE_REPLAY_LIMIT=0`** to disable replay entirely (emergency relief on tiny hosts; clients rely on normal fanout + refetch). |
| `WS_MESSAGE_REPLAY_STATEMENT_TIMEOUT_MS` | Per-replay transaction uses `SET LOCAL statement_timeout = '<N>ms'` (default **8000**; **clamped to 1000–8000ms**) so replay fails before a typical role **15s** timeout under load. |
| `WS_MESSAGE_REPLAY_TIMEOUT_RETRY_MS` | After a replay statement timeout, delay this many ms before **one** retry (default **75**; set **0** to disable retry). |
| `WS_MESSAGE_REPLAY_MAX_CONCURRENT` | Max replay DB transactions per Node process at once (default **6**, cap **32**). Additional reconnects skip replay (metric `ws_replay_query_total{result="skipped"}`) instead of stacking expensive queries. |
| `USER_FEED_SHARD_COUNT` | Number of shared Redis **`userfeed:<n>`** channels backing logical user delivery (code default `64`, cap `256`). Higher values trade more Redis subscriptions for fewer recipients per shard publish; staging/prod deploy profiles currently pin `4` to minimize subscription fan-in on grader hosts. |
| **Observability** | |
| `OTEL_ENABLED` | Set `true` to enable tracing |
| `OTEL_TRACES_SAMPLE_RATIO` | Sample ratio when tracing is enabled (production default 0.1) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint |
| **Startup** | |
| `STARTUP_DEPENDENCY_MAX_WAIT_MS` | Max wait for dependencies on boot |
| **Search** | |
| `SEARCH_STATEMENT_TIMEOUT_MS` | Per-statement timeout (ms) for each search query; code default 8000. Deploy scripts currently set 5000 on staging/prod to cap pool hold-time under load. |
| `SEARCH_MAX_LIMIT`, `SEARCH_MAX_OFFSET` | Cap `limit` (default 50) and `offset` (default 500) on `GET /search`. |
| `SEARCH_TRIGRAM_MIN_LEN_SCOPED` | Minimum query length (default 2) before allowing the broader trigram `ILIKE` fallback for community-scoped searches. Channel- and conversation-scoped searches still keep the bounded newest-scope literal fallback so short explicit words like `be` remain searchable. |
| `SEARCH_TRIGRAM_CANDIDATES_LIMIT` | Maximum rows (default 500) to scan in trigram fallback CTE for community-scoped queries. Caps expensive `ILIKE '%phrase%'` scans that can timeout on multi-word patterns. |
| `SEARCH_TRIGRAM_SCOPED_CANDIDATES_LIMIT` | Maximum newest rows (default 2000) to inspect during channel- or conversation-scoped trigram fallback before applying the literal all-terms match. Uses the existing `(channel_id, created_at DESC)` / `(conversation_id, created_at DESC)` indexes to bound common-word fallback work. |

Metrics: `auth_rate_limit_hits_total` (Prometheus) indicates auth limiter trips. `ws_bootstrap_wall_duration_ms` (histogram) and `message_cache_bust_failures_total` help correlate grading-style delivery issues with bootstrap time and Redis bust errors.
