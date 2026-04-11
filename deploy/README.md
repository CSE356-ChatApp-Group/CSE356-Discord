# Deployment Guide

This document describes the staged deployment pipeline for ChatApp:

- **Dev**: Local + CI containers
- **Staging**: Google Cloud Compute Engine VM
- **Production**: temporary VM at `ubuntu@130.245.136.44`

> Public endpoints currently map as:
> - Staging: `http://136.114.103.71`
> - Production: `http://130.245.136.44`

**Environment variables:** see [docs/env.md](../docs/env.md) for every API tunable and a **production shared `.env` audit** checklist (`/opt/chatapp/shared/.env` on the host).

## Architecture Overview

```
┌─────────────────┐
│  GitHub / Main  │
└────────┬────────┘
         │
         ▼ (on push)
┌──────────────────────┐
│ CI: Build & Package  │  ← Builds once, artifacts locked
│  (GitHub Actions)    │
└─────────┬────────────┘
          │
          ├─────────────────────────────────┐
          │                                 │
          ▼                                 ▼
    ┌──────────────┐               ┌──────────────┐
   │  Staging VM  │               │ Production   │
   │ (Google      │   (Manual)    │ (130.245.136.44) │
    │  Cloud)      │ ──approval──► │              │
    │              │               │              │
    │ Verify       │               │ Validate +   │
    │ behavior +   │               │ cutover      │
    │ integration  │               │              │
    └──────────────┘               └──────────────┘
```

## CI Pipeline

### Trigger
Every push to `main` runs full CI.

### Steps
1. Install dependencies (from `package-lock.json`)
2. TypeScript check
3. Linting
4. Unit and integration tests
5. Build backend (`npm run build` → `backend/dist/`)
6. Build frontend (`npm run build` → `frontend/dist/`)
7. Package artifact:
   - `tar.gz` containing:
     - `backend/dist/`
     - `backend/package*.json`
     - `frontend/dist/`
     - `migrations/`
     - Root `package*.json`
     - `.env.example`
   - Tagged with commit SHA
8. Upload to GitHub Releases

### Artifact
Each release is immutable and tagged by commit SHA. The **same artifact** is deployed to both staging and production.

## GitHub Button Deploys

Staging deploys automatically from GitHub Actions after **CI Build & Package** succeeds on pushes to `main` via `.github/workflows/deploy-staging-auto.yml`.

You can still deploy manually from GitHub Actions using **Manual Deploy** (`workflow_dispatch`) in `.github/workflows/deploy-manual.yml`.

### Required GitHub configuration

- Repository secret: `DEPLOY_SSH_KEY`
   - Private key for SSH access to deploy hosts.
- Repository/environment variables (optional overrides):
   - `STAGING_HOST` (default: `136.114.103.71`)
   - `STAGING_USER` (default: `ssperrottet`)
   - `PROD_HOST` (default: `130.245.136.44`)
   - `PROD_USER` (default: `ubuntu`)
   - If you move production to a new VM/IP, update `PROD_HOST` in GitHub environment variables before running deploys.
- GitHub Environment protection:
   - Set approvals on `production` environment to require manual reviewer approval.

### How to run

1. Open GitHub Actions → **Manual Deploy**.
2. Click **Run workflow**.
3. Choose `environment`: `staging` or `prod`.
4. Optionally provide `sha` (if empty, workflow uses selected ref SHA).

The workflow uses the same deploy scripts as local console deploys, so behavior is consistent.

## Staging Deployment

### Prerequisites
- Staging VM on Google Cloud Compute Engine (Ubuntu 22.04 LTS)
- Staging database (Postgres)
- Staging Redis cache
- GitHub CLI (`gh`) installed locally for artifact download

### Setup (one-time)

1. Create Compute Engine VM:
   ```bash
   gcloud compute instances create chatapp-staging \
     --machine-type=e2-medium \
     --zone=us-central1-b \
     --image-family=ubuntu-2204-lts \
     --image-project=ubuntu-os-cloud
   ```

2. SSH into VM and run setup:
   ```bash
   gcloud compute ssh chatapp-staging
   # Then run staging-vm-setup.sh
   ```

3. Create staging database and Redis:
   ```bash
   # Use Google Cloud SQL for Postgres
   # Use Google Cloud Memorystore for Redis
   # Note connection strings in /opt/chatapp/shared/.env
   ```

### Deploy to Staging

```bash
STAGING_HOST=136.114.103.71 GITHUB_REPO=CSE356-ChatApp-Group/CSE356-Discord ./deploy/deploy-staging.sh <commit-sha>
```

This:
1. Downloads the prebuilt artifact from GitHub Releases
2. Copies to staging VM
3. Unpacks and installs dependencies
4. Starts on candidate port (4001)
5. Runs health checks + smoke tests
6. If healthy, switches Nginx to new version
7. Monitors for 30 seconds
8. Reports success or failure

### Verify Staging

```bash
# SSH to staging
gcloud compute ssh chatapp-staging

# Check current release
source /opt/chatapp/shared/deploy-utils.sh
current_release
list_releases

# Check health
curl http://136.114.103.71/health

# Tail logs (systemd template is `chatapp@PORT`, usually 4000 + 4001)
sudo journalctl -u 'chatapp@*' -f
```

### Rollback Staging

If issues are discovered:

```bash
# Manual rollback via Nginx
ssh <staging-user>@136.114.103.71 "
  sudo sed -i 's/localhost:4001/localhost:4000/' /etc/nginx/sites-available/chatapp
  sudo systemctl reload nginx
"
```

## Production Deployment

### Prerequisites
- Production VM reachable at `ubuntu@130.245.136.44`
- Production database (Postgres)
- Production Redis cache
- Nginx configured for blue-green or candidate-port deployment
- SSH access as `ubuntu` user (or configured user)

### Release Directory Structure

Production uses immutable release directories:

```
/opt/chatapp/
├── releases/
│   ├── 2026-03-27T141500-a1b2c3d/     ← Old release
│   │   ├── backend/dist/
│   │   ├── backend/package*.json
│   │   ├── frontend/dist/
│   │   └── migrations/
│   │
│   └── 2026-03-27T153200-d4e5f6g/     ← New release
│       └── ...
│
├── current -> releases/2026-03-27T153200-d4e5f6g  ← Symlink to active
│
├── shared/
│   ├── .env                           ← Shared secrets
│   ├── logs/
│   └── backups/
```

### Deploy to Production

**Warning: This deploys to production. Ensure staging passed all checks first.**

```bash
# Default is one Node worker (CHATAPP_INSTANCES=1). For production with **both**
# systemd units `chatapp@4000` and `chatapp@4001` and nginx load-balancing, set:
CHATAPP_INSTANCES=2 ./deploy/deploy-prod.sh <commit-sha>
```

`deploy-prod.sh` rewrites the whole `upstream app { ... }` block (no fragile global `sed` on ports). When **`CHATAPP_INSTANCES>=2`**, step **9** only applies **listen backlog / `nginx.conf` / sysctl** tuning and leaves **both** upstreams in place while the candidate warms up. Step **9a** then pins nginx to the **candidate port only** before **9b** stops and restarts the companion (avoids `connection refused` to a peer that is down mid-roll). **9c** restores `least_conn` across both ports with **`max_fails=2 fail_timeout=10s`** so nginx can mark a dead peer down. There is still a **shared-traffic window** before **9a** where **old and new code** may both serve requests; keep DB migrations and API responses **backward compatible** across that window. After **9a**, capacity is on the candidate only until **9c** completes.

**GitHub Actions:** manual prod deploy passes `chatapp_instances` (default **2** via `CHATAPP_INSTANCES_PROD` repo variable or literal `2` in `deploy-manual.yml`). Set repo variable `CHATAPP_INSTANCES_PROD` to `1` only if you intentionally run a single worker.

This:
1. Confirms you want to deploy to production (interactive prompt)
2. Backs up production database
3. Downloads the artifact from GitHub Releases
4. Copies to production server
5. Unpacks candidate release
6. Starts on alternate port (4001) **without touching running traffic**
7. Runs health checks + smoke tests against candidate
8. **Only if healthy**, updates Nginx: **single-worker** → traffic to candidate only; **dual-worker** → tune only with both upstreams, pin to candidate (**9a**), roll companion (**9b**), restore dual upstream (**9c**)
9. Monitors for 60 seconds
10. Updates `current` symlink
11. Keeps old version running on original port for instant rollback

### Production nginx audit (dual upstream)

After any hand-edited nginx config or if you see `no live upstreams` in `error.log`:

```bash
./scripts/prod-nginx-audit.sh
```

This fails if **both** `chatapp@4000` and `chatapp@4001` are active but `upstream app` does not list **both** ports (a common mis-cutover symptom).

### Capacity gate before tuning prod

Run load on **staging** first (same `CHATAPP_INSTANCES` shape as prod when possible):

```bash
# Steady SLO probe (~8m) — see optimization_* thresholds in staging-capacity.js
./scripts/run-staging-capacity.sh slo

# Stress envelope (expect threshold breaches; read optimization_* and failure mix)
./scripts/run-staging-capacity.sh break
```

Promote pool / `FANOUT_QUEUE_CONCURRENCY` / `OVERLOAD_*` changes to prod only after staging artifacts look acceptable.

### Scaling up (8 vCPU) or moving Postgres off-box

**Vertical scale (recommended first step)**  
1. Resize the production VM to **8 vCPU** (and **≥16 GiB RAM** if the platform allows — you still run **PostgreSQL + PgBouncer + two Node workers + nginx + Redis** on one host).  
2. Run a normal prod deploy (`CHATAPP_INSTANCES=2`). [`deploy-prod.sh`](./deploy-prod.sh) probes **`nproc`** and **`MemTotal`** on the VM and recomputes **PgBouncer `default_pool_size`**, **`PG_POOL_MAX` per instance**, **`max_connections`**, **`FANOUT_QUEUE_CONCURRENCY`**, **`BCRYPT_MAX_CONCURRENT`**, heap caps, etc. You do **not** hand-edit pool sizes for a larger SKU unless you are doing something special.  
3. If PostgreSQL needs a restart to apply a higher `max_connections`, either set **`ALLOW_DB_RESTART=true`** for that one deploy (see script header / postgres tuning block) or restart Postgres once after deploy when maintenance allows.

**Why this matters:** older sizing used a term that **capped** the PgBouncer pool at **170** for any **two-worker** host with **≥4 vCPU**, so **going from 4→8 vCPU did not increase DB backend headroom**. The current formula scales **`ncpu * 50`** (plus a small multi-worker bump), up to **320** real backends — e.g. **8 vCPU / 2 workers** → **320** pool, **~170** virtual clients per Node cap (see deploy log line at start of run).

**Horizontal DB (managed Postgres)**  
Useful when the **database** is the bottleneck or you want RAM/IO isolated from Node:

- Create a **managed** instance (same region as the app VM if possible).  
- Set **`DATABASE_URL`** in `/opt/chatapp/shared/.env` to the provider connection string. For TLS, append **`?sslmode=require`** (or your provider’s required params) so `node-pg` negotiates SSL.  
- Re-run deploy (or at least the **PgBouncer** step in `deploy-prod.sh`): [`pgbouncer-setup.py`](./pgbouncer-setup.py) builds the `[databases]` stanza from the parsed host/port so PgBouncer on the **app VM** still **pools** to the remote Postgres (transaction mode).  
- **Security groups / firewall**: allow **outbound 5432** (or provider port) from the app VM to the DB; restrict DB ingress to that VM’s IP.  
- Ensure the DB **tier connection limit** is **≥** the deploy-time **`max_connections`** target (upper hundreds after scale-up — check the deploy banner line `pg_max_conn=...`).

**Not covered in-repo:** running **extra Node HTTP workers** beyond **4000+4001** (third port) would need **nginx + systemd + CI** changes; ask course staff before doing that.

### Immediate Rollback

If issues are detected after cutover, **`rollback_cutover`** inside `deploy-prod.sh` points nginx at the prior live port (single upstream). For a manual emergency fix, **do not** use a blind `sed` swapping ports (it breaks dual-upstream). Prefer re-running `./deploy/deploy-prod.sh <previous-sha>` or restoring `upstream app` to two healthy `server` lines and `sudo nginx -t && sudo systemctl reload nginx`.

Old process is still running and will resume handling traffic.

### Clean Up Old Releases

After confidence window (~10 minutes):

```bash
ssh ssperrottet@136.114.103.71 "
  # Stop the old process
  pkill -f 'PORT=4000' || true
  
  # Keep releases for rollback, delete very old ones (keep last 5)
  ls -1dt /opt/chatapp/releases/*/ | tail -n +6 | xargs rm -rf
"
```

## Health Checks

### `/health` Endpoint

Returns 200 if:
- Process is running
- Database is reachable
- Redis is reachable

```bash
curl http://localhost:3000/health
# {"status":"ok","timestamp":"2026-03-27T14:15:00.000Z"}
```

Returns 503 if any check fails.

### Pre-Cutover Validation

```bash
./deploy/health-check.sh <port>
```

### Smoke Tests

```bash
./deploy/smoke-test.sh <port>
```

Verifies:
- HTTP health endpoint 200
- API reachable
- Process listening
- Database connected

## Migration Strategy

### Before Deploying

1. **Database migrations only run in compatible direction**:
   - Only additive schema changes
   - No destructive migrations without rollback plan

2. **Review migration**:
   - Run migrations on staging first
   - Verify they work on production data model

3. **Backup database**:
   - `deploy-prod.sh` automatically backs up before deploy
   - Keep backups for at least 24 hours

### Post-deploy schema verification

After a deploy that includes **long-running migrations** (for example `009_channel_last_message_denorm.sql`), confirm the database is in a good state before considering the release healthy:

```bash
# From any host with psql and network access to Postgres:
DATABASE_URL='postgres://user:pass@host:5432/dbname' ./deploy/verify-schema.sh
```

The script checks that:

- `009_channel_last_message_denorm.sql` is recorded in `schema_migrations`
- `channels` has `last_message_id`, `last_message_author_id`, and `last_message_at`

**If a previous deploy failed mid-migration**, do not assume re-running `node dist/db/migrate.js` is safe. Inspect `schema_migrations`, the `channels` columns, and Postgres logs; finish or roll back DDL under a maintenance window if needed.

Manual spot checks (optional):

```sql
SELECT filename FROM schema_migrations WHERE filename LIKE '009%';
SELECT column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'channels'
   AND column_name LIKE 'last_message%';
```

### Capacity: nginx, file descriptors, and swap under load

Grading and load tests open many **HTTP + WebSocket** connections on a small VM. If you see **timeouts, status 0, or upstream failures** before CPU maxes out, check:

1. **Nginx `worker_connections`** (in `/etc/nginx/nginx.conf` inside the `events { }` block). The repo’s [`infrastructure/nginx/nginx.conf`](../infrastructure/nginx/nginx.conf) uses **16384** (aligned with `deploy-prod.sh` / `prod-vm-setup.sh`); default distro configs are often **768** and can bottleneck WebSocket fan-in. **`deploy-prod.sh` rewrites this on deploy**; if you still see `worker_connections are not enough` in `error.log`, raise `NGINX_WORKER_CONNECTIONS` for that run. After manual edits, `sudo nginx -t && sudo systemctl reload nginx`.
2. **Search proxy read timeout**: `location /api/` uses **30s** read timeout; slow-but-successful searches were getting **502** from nginx. **`deploy-prod.sh` step 9.05** inserts `location ^~ /api/v1/search` with **90s** (`proxy_read_timeout` / `proxy_send_timeout`) when missing. Templates in [`deploy/prod-vm-setup.sh`](./prod-vm-setup.sh) and [`deploy/nginx/staging.conf`](./nginx/staging.conf) include the same block.

3. **`LimitNOFILE`** for the Node process: the systemd template [`deploy/chatapp-template.service`](./chatapp-template.service) sets **65535** — ensure production units match.

4. **Swap thrash**: sustained **swap in/out** (not just “some swap used”) hurts latency. If `vmstat` shows high `si`/`so` during tests, add RAM or reduce colocated services; application-level pagination only helps when clients use smaller pages.

5. **Access logs**: keep **JWTs out of nginx access logs** (do not log the `Authorization` header).

### During Deploy

- Old and new versions coexist briefly
- Only switch traffic after new version starts successfully
- If new version crashes during startup → old version untouched

## Observability

### Where application logs go

- The Node process runs under **systemd** units `chatapp@4000` and `chatapp@4001` (see [`deploy/chatapp-template.service`](./chatapp-template.service): `StandardOutput=journal`, `StandardError=journal`, `SyslogIdentifier=chatapp-%i`).
- Logging is **Pino** (`backend/src/utils/logger.ts`). In production, default **`LOG_LEVEL=info`** (overridable in `/opt/chatapp/shared/.env`).
- **HTTP request logging** (`pino-http` in `backend/src/app.ts`): successful, fast requests are logged at **`silent`** in production (so the journal is not flooded). You **will** still see:
  - **`warn`**: HTTP **4xx**, or responses slower than **~1s**
  - **`error`**: HTTP **5xx**, or thrown errors before the response finishes
  - Any `logger.warn` / `logger.error` from the app

So: **yes, you see app-level problems in journald**—mostly as `warning` and `error` priorities, not as noise from every 200 OK.

### Logs (production)

```bash
ssh ubuntu@130.245.136.44

# Live tail (both workers)
sudo journalctl -u 'chatapp@*' -f

# Recent warnings + errors only (good default when debugging)
sudo journalctl -u 'chatapp@*' --since '1 hour ago' -p warning --no-pager | less

# One-shot snapshot from your laptop (requires SSH key)
./scripts/prod-observe.sh
# Optional: SINCE='24 hours ago' ./scripts/prod-observe.sh
```

**Nginx** (upstream dead, timeouts) — always check alongside the app:

```bash
sudo tail -n 50 /var/log/nginx/error.log
sudo grep '\[error\]' /var/log/nginx/error.log | tail -n 20
# If logrotate ran, also check /var/log/nginx/error.log.1
```

**Correlate a dashboard spike with logs** (access uses `DD/Mon/YYYY`, errors use `YYYY/MM/DD`; VM clock is usually UTC):

```bash
# Example: Apr 8 grader window 19:00–22:00 on the server clock
./scripts/prod-log-correlate.sh '08/Apr/2026' '2026/04/08' 19 22
```

If the UI is **US/Eastern**, shift hours (e.g. 20:00 EDT ≈ next calendar day 00:00 UTC).

### Health Monitoring

Set up alerting:
- Monitor `GET /health` every 30 seconds
- Alert if 503 or 5xx response
- Alert if timeout (service down)
- Set `ALERT_ENVIRONMENT=staging` on staging and `ALERT_ENVIRONMENT=production` on prod
- Put the matching `DISCORD_WEBHOOK_URL_STAGING=...` or `DISCORD_WEBHOOK_URL_PROD=...` in `/opt/chatapp/shared/.env`
- Redeploy or restart `alertmanager` + `prometheus` so Discord notifications go live
- `deploy-prod.sh` now validates Alertmanager webhook wiring and fails fast if it is blank/invalid (prevents silent alert loss)
- Use `http://127.0.0.1:9093` on the monitor host to verify active alerts and silences

### WebSocket Connections

After deployment, verify WebSocket stability:
- Check for broken connections in logs
- Monitor presence federation reliability
- Verify no connection drops during Nginx reload

## Environment Files

### Staging `.env`

Edit `/opt/chatapp/shared/.env` on staging VM:
- Point to staging database
- Point to staging Redis
- Use staging secrets (different from production)
- Set `NODE_ENV=staging`

### Production `.env`

Create `/opt/chatapp/shared/.env` on production VM:
- Point to production database
- Point to production Redis
- Use production secrets
- Set `NODE_ENV=production`

**Small VM (~2 GiB RAM) overload tuning** (optional; see `backend/src/utils/overload.ts`):
- Example: `OVERLOAD_RSS_WARN_MB=384`, `OVERLOAD_RSS_HIGH_MB=512`, `OVERLOAD_RSS_CRITICAL_MB=768`
- Enter HTTP shedding only if needed: `OVERLOAD_HTTP_SHED_ENABLED=true` (prefer fixing pool/CPU first)
- After edits: `sudo systemctl restart 'chatapp@*'`

**Fanout:** `FANOUT_QUEUE_CONCURRENCY` is written by `deploy-prod.sh` from VM shape; raise only after staging load tests show headroom.

### Course grader: “delivery fails” vs HTTP 403

**Throughput / delivery SLA (15s per listener, outage rollup):** see [`docs/GRADING-DELIVERY-SEMANTICS.md`](../docs/GRADING-DELIVERY-SEMANTICS.md) — maps the forum definition to WebSocket vs HTTP and lists common non-bug patterns.

Automated graders often count **`POST /api/v1/messages` without `201`** as a delivery failure. Your API returns **`403`** when the user may not post to that **private channel** or **conversation** (`Access denied` / `Not a participant`). That is **authorization**, not network or WebSocket failure. Under heavy grader traffic, **201 and 403 can each be ~half** of message POSTs if the harness mixes allowed and forbidden cases—or if clients post before join completes. Use `./scripts/prod-observe.sh` (POST /messages status breakdown) and `./scripts/prod-log-correlate.sh` for an hour-bucketed split.

**Ask your instructor explicitly:** does the leaderboard treat **expected `403`** on `POST /messages` as a *delivery fail*, or only **5xx / timeouts / missed WebSocket delivery**?

Both environments are identical in structure but differ in:
- Database credentials
- Redis credentials
- OAuth keys (if different)
- Log levels

## Troubleshooting

### Deploy fails: "Health check failed"

1. SSH to target and check logs:
   ```bash
   tail -50 /var/log/chatapp-candidate.log
   ```

2. Verify environment:
   - Database connectivity: `psql $DATABASE_URL`
   - Redis connectivity: `redis-cli -u $REDIS_URL ping`

3. Manual health check:
   ```bash
   ./deploy/health-check.sh 4001
   ```

### Deploy fails: "Database backup failed"

- This is non-fatal if you have recent snapshots elsewhere
- Proceed manually after verifying backups exist

### Rollback doesn't work

If you reverted Nginx but new version is still serving:
```bash
# Find and kill the candidate process
ssh ssperrottet@136.114.103.71 "pkill -f 'PORT=4001'"
# Then reload Nginx
ssh ssperrottet@136.114.103.71 "sudo systemctl reload nginx"
```

### WebSocket errors after deploy

- Clear browser cache (old frontend artifact)
- Check that Nginx is properly configured for WebSocket upgrades
- Monitor logs for connection drops

## Checklist: Before Every Production Deploy

- [ ] CI passed (all tests, builds green)
- [ ] Artifact built from locked `package-lock.json`
- [ ] Staging deployment succeeded
- [ ] Staging validated (health, smoke tests, manual checks)
- [ ] Database migrations reviewed and tested on staging
- [ ] Prod database backup is recent and verified
- [ ] Rollback plan confirmed
- [ ] On-call person aware of deployment
- [ ] Team notified (if needed)
- [ ] Monitoring dashboard open during deploy

## Checklist: During Production Deploy

- [ ] Run deploy script
- [ ] Watch for health failures during candidate startup
- [ ] Verify traffic switches to new version
- [ ] Monitor error rate for 5 minutes post-cutover
- [ ] Keep old version running for quick rollback
- [ ] Check that WebSocket connections are stable
- [ ] Verify presence reads/writes working

## Checklist: After Production Deploy

- [ ] `./scripts/prod-nginx-audit.sh` passes (dual workers ⇒ both `:4000` and `:4001` in `upstream app`)

- [ ] Confirm all metrics normal
- [ ] No unusual error spikes
- [ ] WebSocket connections healthy
- [ ] Database queries performing normally
- [ ] Presence federation working
- [ ] Wait 10 minutes monitoring before cleanup
- [ ] Clean up old process and old release (optional)
- [ ] Update deployment log

## CI/CD Artifacts and Storage

All artifacts are tagged with SHA and stored in GitHub Releases for:
- Reproducibility: download exact same artifact for any deploy
- Audit trail: see which code version is in production
- Rollback: quickly re-deploy previous release by SHA

No rebuild happens for staging/prod deploys — use the exact CI artifact.

## Questions?

For deployment issues, check logs:
- **CI logs**: GitHub Actions → Workflow runs
- **Staging logs**: SSH to staging, `sudo journalctl -u 'chatapp@*' -f` and nginx under `/var/log/nginx/`
- **Prod logs**: SSH to `ubuntu@130.245.136.44`, then `sudo journalctl -u 'chatapp@*' …` (see **Observability** above) or run `./scripts/prod-observe.sh`

For architectural questions, refer to the main [README.md](../README.md).
