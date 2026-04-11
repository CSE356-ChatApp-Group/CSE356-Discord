# Environment variables

Developer copy: [`.env.example`](../.env.example). Deploy scripts compute pool sizing on staging/production VMs (`deploy/deploy-staging.sh`, `deploy/deploy-prod.sh`).

## Grading / autograder hosts

If the VM is **only** hit by course autograders (no general public) and you do not care about auth brute-force or spam, set **`DISABLE_RATE_LIMITS=true`** in `/opt/chatapp/shared/.env`, then restart the API (`sudo systemctl restart 'chatapp@*'` or your usual rollout). That removes throttling on register, login, and OAuth connect ([`backend/src/auth/router.ts`](../backend/src/auth/router.ts)). Omit or set to `false` when you want limits back.

## Production shared `.env` audit (real-user deployments)

On the production host, inspect `/opt/chatapp/shared/.env` (used by systemd `chatapp@` units). **SSH access is required; this checklist is not runnable from CI.**

1. **`DISABLE_RATE_LIMITS`** should **not** be `true` when the app faces untrusted traffic. If set, all auth route rate limiting is disabled (register, login, oauth-connect). **Grading-only hosts are an exception** — see above.
2. **`AUTH_REGISTER_RATE_LIMIT_MAX`**, **`AUTH_LOGIN_RATE_LIMIT_MAX`**, **`AUTH_CONNECT_RATE_LIMIT_MAX`** — only set if you intentionally override [defaults in `backend/src/auth/router.ts`](../backend/src/auth/router.ts) (register 20 / 10 min, login 60 / 1 min, connect 30 / 5 min). Absent vars use those defaults.
3. **Window overrides** (`AUTH_*_RATE_LIMIT_WINDOW_MS`) — same as above; omit unless tuning.
4. **`OVERLOAD_HTTP_SHED_ENABLED`** — `deploy-prod.sh` sets this to `false`. Production should **not** copy staging values (`true` + low `OVERLOAD_LAG_SHED_MS`) unless you deliberately want HTTP 503 shedding under event-loop lag.
5. **`AUTH_BYPASS`** — should **not** be `true` when grading real authentication behavior (use `false` for real-user prod). **`deploy-prod.sh`** forces **`AUTH_BYPASS=false`** and **`NODE_ENV=production`** on every deploy.
6. **`NODE_ENV`** — should be **`production`** on the API host; **`deploy-prod.sh`** enforces it.
7. **`OVERLOAD_LAG_SHED_MS`** — **`deploy-prod.sh`** sets **`250`** (matches code default when HTTP shedding is enabled). **`OVERLOAD_HTTP_SHED_ENABLED`** remains **`false`** on prod unless you opt in.

**Repository audit (no server access):** `DISABLE_RATE_LIMITS` and `AUTH_*_RATE_LIMIT_*` do not appear in deploy scripts (set manually on grading-only hosts if desired). [`docker-compose.yml`](../docker-compose.yml) sets high register/login limits (500) **only** for the local `api` service to support parallel E2E; production does not use that compose stack as-is. Channel **`message:created`** per-user Redis fanout is **on by default in code**; compose and [`deploy/deploy-staging.sh`](../deploy/deploy-staging.sh) / [`deploy/deploy-prod.sh`](../deploy/deploy-prod.sh) **re-apply on every deploy** **`CHANNEL_MESSAGE_USER_FANOUT=true`**, **`CHANNEL_MESSAGE_USER_FANOUT_MAX=10000`**, and **`WS_BOOTSTRAP_BATCH_SIZE=120`**, plus prod-only **`NODE_ENV=production`**, **`AUTH_BYPASS=false`**, **`OVERLOAD_HTTP_SHED_ENABLED=false`**, and **`OVERLOAD_LAG_SHED_MS=250`** (see script block in `deploy-prod.sh`).

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
| `DISABLE_RATE_LIMITS` | `true` disables auth rate limits; use on isolated grading hosts if desired |
| `AUTH_REGISTER_RATE_LIMIT_MAX`, `AUTH_REGISTER_RATE_LIMIT_WINDOW_MS` | Register limiter |
| `AUTH_LOGIN_RATE_LIMIT_MAX`, `AUTH_LOGIN_RATE_LIMIT_WINDOW_MS` | Login limiter |
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
| `COMMUNITIES_LIST_CACHE_TTL_SECS`, `CHANNELS_LIST_CACHE_TTL_SECS` | List route cache TTLs |
| `PRESENCE_FANOUT_CACHE_TTL_SECONDS` | Presence fanout cache |
| **WebSocket** | |
| `WS_BACKPRESSURE_DROP_BYTES`, `WS_BACKPRESSURE_KILL_BYTES` | Backpressure thresholds |
| `WS_ACL_CACHE_MAX_ENTRIES`, `WS_BOOTSTRAP_BATCH_SIZE`, `WS_BOOTSTRAP_CACHE_TTL_SECONDS` | WS tuning |
| `CHANNEL_MESSAGE_USER_FANOUT`, `CHANNEL_MESSAGE_USER_FANOUT_MAX` | **Default on:** also publish channel `message:created` to each visible member’s `user:<id>` (set `0`/`false` to disable). Cap members (default **5000**, max **10000**); clients dedupe by message id. |
| **Observability** | |
| `OTEL_ENABLED` | Set `false` to disable tracing |
| `OTEL_TRACES_SAMPLE_RATIO` | Sample ratio (production default 0.1) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP HTTP endpoint |
| **Startup** | |
| `STARTUP_DEPENDENCY_MAX_WAIT_MS` | Max wait for dependencies on boot |

Metrics: `auth_rate_limit_hits_total` (Prometheus) indicates auth limiter trips. `ws_bootstrap_wall_duration_ms` (histogram) and `message_cache_bust_failures_total` help correlate grading-style delivery issues with bootstrap time and Redis bust errors.
