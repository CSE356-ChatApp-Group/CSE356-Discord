# Environment variables

Developer copy: [`.env.example`](../.env.example). Deploy scripts compute pool sizing on staging/production VMs (`deploy/deploy-staging.sh`, `deploy/deploy-prod.sh`).

## Grading / autograder hosts

If the VM is **only** hit by course autograders (no general public) and you do not care about auth brute-force or spam, set **`DISABLE_RATE_LIMITS=true`** in `/opt/chatapp/shared/.env`, then restart the API (`sudo systemctl restart 'chatapp@*'` or your usual rollout). That removes throttling on register, login, and OAuth connect ([`backend/src/auth/router.ts`](../backend/src/auth/router.ts)), and also disables the optional **`POST /api/v1/rum`** rate limiter when browser RUM is enabled ([`backend/src/rum/router.ts`](../backend/src/rum/router.ts)). Omit or set to `false` when you want limits back.

**POST `/api/v1/messages`:** **201** includes explicit realtime fields — not one ambiguous “complete” flag. **Channel** posts: `realtimeChannelFanoutComplete: true` after the `channel:<uuid>` Redis publish; `realtimeUserFanoutDeferred: true|false` states whether per-member `user:` duplicates finished before **201** (`MESSAGE_USER_FANOUT_HTTP_BLOCKING`). **Conversation/DM** posts: `realtimeConversationFanoutComplete: true`. End-to-end browser delivery is still asynchronous; graders often allow **~15s** per listener.

## Auth bursts without extra 429s

If you **do not** want **`AUTH_GLOBAL_PER_IP_RATE_LIMIT`** (or you keep **`DISABLE_RATE_LIMITS=true`** on graders), overload shows up as **long latency** and **nginx 502/504**, not JSON 429 from that feature. Mitigations are **capacity and timeouts**, not more silent queueing on one small VM:

1. **More API processes** — e.g. **`CHATAPP_INSTANCES=2`** (or higher) with nginx balancing **two ports**, when the host has **enough CPU and RAM** (each Node heap is sized in deploy scripts).
2. **Larger or additional VMs** — horizontal scale + connection pool tuning (Postgres / PgBouncer).
3. **`BCRYPT_MAX_CONCURRENT`** / **`BCRYPT_ROUNDS`** — trade security vs CPU only with care; raising concurrency increases parallel CPU load.
4. **Nginx `proxy_read_timeout` on `/api/v1/auth/`** — already raised in repo templates (**75s**) so fewer **504 HTML** pages while upstream is slow; clients still wait longer.

There is no way to accept **unlimited** simultaneous bcrypt-heavy logins on **finite** hardware with bounded latency; the choice is **where** overload appears (app JSON vs nginx HTML vs long waits).

## Production shared `.env` audit (real-user deployments)

On the production host, inspect `/opt/chatapp/shared/.env` (used by systemd `chatapp@` units). **SSH access is required; this checklist is not runnable from CI.**

1. **`DISABLE_RATE_LIMITS`** should **not** be `true` when the app faces untrusted traffic. If set, auth route rate limiting is disabled (register, login, oauth-connect) and the optional RUM limiter is disabled. **Grading-only hosts are an exception** — see above.
2. **`AUTH_REGISTER_RATE_LIMIT_MAX`**, **`AUTH_LOGIN_RATE_LIMIT_MAX`**, **`AUTH_CONNECT_RATE_LIMIT_MAX`** — only set if you intentionally override [defaults in `backend/src/auth/router.ts`](../backend/src/auth/router.ts) (register 20 / 10 min, login 60 / 1 min, connect 30 / 5 min). Absent vars use those defaults. **`AUTH_GLOBAL_PER_IP_RATE_LIMIT=true`** enables **extra** per-IP caps (`AUTH_*_GLOBAL_PER_IP_*`) that return **429** under stampede; leave unset/false if you prefer not to deny on that axis (then add **capacity** instead — see below).
3. **Window overrides** (`AUTH_*_RATE_LIMIT_WINDOW_MS`) — same as above; omit unless tuning.
4. **`OVERLOAD_HTTP_SHED_ENABLED`** — `deploy-prod.sh` sets this to `false`. Production should **not** copy staging values (`true` + low `OVERLOAD_LAG_SHED_MS`) unless you deliberately want HTTP 503 shedding under event-loop lag.
5. **`AUTH_BYPASS`** — should **not** be `true` when grading real authentication behavior (use `false` for real-user prod). **`deploy-prod.sh`** forces **`AUTH_BYPASS=false`** and **`NODE_ENV=production`** on every deploy.
6. **`NODE_ENV`** — should be **`production`** on the API host; **`deploy-prod.sh`** enforces it.
7. **`OVERLOAD_LAG_SHED_MS`** — **`deploy-prod.sh`** sets **`250`** (matches code default when HTTP shedding is enabled). **`OVERLOAD_HTTP_SHED_ENABLED`** remains **`false`** on prod unless you opt in.

**Repository audit (no server access):** `DISABLE_RATE_LIMITS` and `AUTH_*_RATE_LIMIT_*` do not appear in deploy scripts (set manually on grading-only hosts if desired). [`docker-compose.yml`](../docker-compose.yml) sets high register/login limits (500) **only** for the local `api` service to support parallel E2E; production does not use that compose stack as-is. Channel **`message:created`** per-user Redis fanout is **on by default in code**; compose and [`deploy/deploy-staging.sh`](../deploy/deploy-staging.sh) / [`deploy/deploy-prod.sh`](../deploy/deploy-prod.sh) **re-apply on every deploy** **`CHANNEL_MESSAGE_USER_FANOUT=true`**, **`CHANNEL_MESSAGE_USER_FANOUT_MAX=10000`**, **`WS_BOOTSTRAP_BATCH_SIZE=64`**, **`WS_BOOTSTRAP_CACHE_TTL_SECONDS=180`**, **`COMMUNITIES_LIST_CACHE_TTL_SECS=300`**, and **`CHANNELS_LIST_CACHE_TTL_SECS=300`**, plus prod-only **`NODE_ENV=production`**, **`AUTH_BYPASS=false`**, **`OVERLOAD_HTTP_SHED_ENABLED=false`**, and **`OVERLOAD_LAG_SHED_MS=250`** (see script block in `deploy-prod.sh`).

## Backend API (`backend/src`) — optional tunables

All have defaults in code unless noted. Omit in `.env` for normal operation.

| Variable | Purpose |
|----------|---------|
| **Core** | |
| `NODE_ENV` | `development` / `production` |
| `PORT` | HTTP port |
| `LOG_LEVEL` | Pino level (production default `info`) |
| `LOG_SERVICE_NAME` | Service name in logs / tracing |
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
| `DISABLE_RATE_LIMITS` | `true` disables auth rate limits and (when RUM is enabled) `POST /api/v1/rum` limits; use on isolated grading hosts if desired |
| `AUTH_REGISTER_RATE_LIMIT_MAX`, `AUTH_REGISTER_RATE_LIMIT_WINDOW_MS` | Register limiter (per IP + credential) |
| `AUTH_GLOBAL_PER_IP_RATE_LIMIT` | Set to `true` to enable global per-IP login/register 429 caps; **default off** (no extra denials) |
| `AUTH_REGISTER_GLOBAL_PER_IP_MAX`, `AUTH_REGISTER_GLOBAL_PER_IP_WINDOW_MS` | Register cap per client IP only (defaults apply when global IP limit is enabled; **skipped when `NODE_ENV=test`**) |
| `AUTH_LOGIN_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` | Login limiter (per IP + credential) |
| `AUTH_LOGIN_GLOBAL_PER_IP_MAX`, `AUTH_LOGIN_GLOBAL_PER_IP_WINDOW_MS` | Login cap per client IP only (defaults apply when enabled; **skipped when `NODE_ENV=test`**) |
| `AUTH_CONNECT_RATE_LIMIT_MAX`, `AUTH_CONNECT_RATE_LIMIT_WINDOW_MS` | OAuth connect-existing limiter |
| `OAUTH_PENDING_SECRET`, `OAUTH_LINK_SECRET` | OAuth state tokens (fallback: JWT secrets) |
| `BCRYPT_MAX_CONCURRENT`, `BCRYPT_MAX_WAITERS`, `BCRYPT_QUEUE_WAIT_TIMEOUT_MS` | Password hashing queue |
| `BCRYPT_ROUNDS` | bcrypt cost |
| **OAuth providers** | |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Google OAuth |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` | GitHub OAuth |
| `COURSE_OIDC_DISCOVERY_URL`, `COURSE_OIDC_CLIENT_ID`, `COURSE_OIDC_CLIENT_SECRET`, `COURSE_OIDC_CALLBACK_URL` | Course OIDC |
| **Postgres pool** | |
| `PG_POOL_MAX`, `POOL_CIRCUIT_BREAKER_QUEUE` | Pool size and circuit-breaker queue |
| `PG_SLOW_QUERY_MS`, `PG_CONNECTION_TIMEOUT_MS`, `PG_IDLE_TIMEOUT_MS` | Pool behavior |
| `READ_RECEIPT_DEFER_POOL_WAITING` | Soft-defer `PUT /messages/:id/read` when pool waiters reach this threshold (default 8) to protect message-post and read/list latency under burst |
| **Overload / degradation** | |
| `OVERLOAD_RSS_WARN_MB`, `OVERLOAD_RSS_HIGH_MB`, `OVERLOAD_RSS_CRITICAL_MB` | RSS thresholds (MB) |
| `OVERLOAD_LAG_WARN_MS`, `OVERLOAD_LAG_HIGH_MS`, `OVERLOAD_LAG_CRITICAL_MS` | Event-loop p99 lag (ms) |
| `FORCE_OVERLOAD_STAGE` | Force stage 0–3 (testing) |
| `OVERLOAD_HTTP_SHED_ENABLED` | `true` to return 503 when lag ≥ `OVERLOAD_LAG_SHED_MS` |
| `OVERLOAD_LAG_SHED_MS` | Lag threshold for HTTP shed (default 250) |
| **Redis / messages** | |
| `REDIS_FANOUT_PUBLISH_MAX_ATTEMPTS` | Retries for channel publish (default 4) |
| `MSG_IDEM_PENDING_TTL_SECS`, `MSG_IDEM_SUCCESS_TTL_SECS` | POST /messages idempotency TTLs |
| `FANOUT_QUEUE_CONCURRENCY`, `FANOUT_CRITICAL_MAX_DEPTH` | Side-effect / fanout queue |
| **S3** | |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_INTERNAL_ENDPOINT` | Bucket and endpoints |
| `S3_PRESIGN_SIGNING_ENDPOINT` | Presign signing host when public URL differs |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | Credentials |
| **HTTP / caches** | |
| `COMMUNITIES_LIST_CACHE_TTL_SECS`, `CHANNELS_LIST_CACHE_TTL_SECS` | List route cache TTLs (deploy default: `300`) |
| `COMMUNITIES_HEAVY_QUERY_TIMEOUT_MS` | Per-query timeout (ms) for heavy `GET /communities` unread-count SQL before falling back to a lightweight member-count response (default `2500`) |
| `CHANNEL_MESSAGE_PUBLISH_CHANNEL_FIRST` | When `true` (default), `message:created` is published to `channel:<uuid>` before per-member `user:` duplicates |
| `CHANNEL_MESSAGE_USER_FANOUT_MAX` | Max per-message **`user:`** duplicate publishes (default **10000**, cap **10000**). Members beyond this rely on **`channel:`** delivery only — intentional for mega-channels; clients must listen on `channel:` or accept missing `user:` duplicate. |
| `MESSAGE_USER_FANOUT_HTTP_BLOCKING` | When `true` (default), `POST /messages` awaits all `user:` Redis publishes; when `false`, enqueue after `channel:` publish (`realtimeUserFanoutDeferred: true` on **201**) |
| `MESSAGE_INGEST_STREAM_ENABLED`, `MESSAGE_INGEST_STREAM_CONSUMER` | `1`/`true` to append channel message metadata to Redis Stream `MESSAGE_INGEST_STREAM_KEY` and run an ACK consumer (pipeline hook before Kafka/NATS) |
| `MESSAGE_INGEST_STREAM_KEY`, `MESSAGE_INGEST_STREAM_GROUP`, `MESSAGE_INGEST_STREAM_MAXLEN` | Stream name, consumer group, approximate max stream length |
| `PG_READ_REPLICA_URL`, `PG_READ_POOL_MAX` | Optional read replica for `GET /api/v1/messages` list `SELECT`s ([`docs/db-scaling-messages.md`](db-scaling-messages.md)). Request **`X-ChatApp-Read-Consistency: primary`** on that GET to force the primary when you need read-your-writes after a POST. |
| `PRESENCE_FANOUT_CACHE_TTL_SECONDS` | Presence fanout cache |
| **WebSocket** | |
| `WS_BACKPRESSURE_DROP_BYTES`, `WS_BACKPRESSURE_KILL_BYTES` | Backpressure thresholds |
| `WS_ACL_CACHE_MAX_ENTRIES`, `WS_BOOTSTRAP_BATCH_SIZE`, `WS_BOOTSTRAP_CACHE_TTL_SECONDS` | WS tuning (deploy defaults: `64` and `180`) |
| **Observability** | |
| `OTEL_ENABLED` | Set `false` to disable tracing |
| `OTEL_TRACES_SAMPLE_RATIO` | Sample ratio (production default 0.1) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint |
| **Startup** | |
| `STARTUP_DEPENDENCY_MAX_WAIT_MS` | Max wait for dependencies on boot |
| **Search** | |
| `SEARCH_STATEMENT_TIMEOUT_MS` | Per-statement timeout (ms) for each search query; code default 8000. Deploy scripts currently set 5000 on staging/prod to cap pool hold-time under load. |
| `SEARCH_MAX_LIMIT`, `SEARCH_MAX_OFFSET` | Cap `limit` (default 50) and `offset` (default 500) on `GET /search`. |
| `SEARCH_TRIGRAM_MIN_LEN_UNSCOPED` | Minimum query length (default 4) before allowing trigram `ILIKE` fallback when search is **unscoped**; scoped searches still allow short/infix queries. |
| `SEARCH_TRIGRAM_MIN_LEN_SCOPED` | Minimum query length (default 2) before allowing trigram `ILIKE` fallback when search is scoped by `communityId`, `channelId`, or `conversationId`; reduces one-character fallback scans on hot paths. |

Metrics: `auth_rate_limit_hits_total` (Prometheus) indicates auth limiter trips. `ws_bootstrap_wall_duration_ms` (histogram) and `message_cache_bust_failures_total` help correlate grading-style delivery issues with bootstrap time and Redis bust errors.
