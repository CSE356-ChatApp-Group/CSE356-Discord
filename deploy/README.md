# Deployment Guide

This document describes the staged deployment pipeline for ChatApp:

- **Dev**: Local + CI containers
- **Staging**: Google Cloud Compute Engine VM
- **Production**: temporary VM at `ubuntu@130.245.136.44`

> Public endpoints currently map as:
> - Staging: `http://136.114.103.71`
> - Production: `http://130.245.136.44`

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

# Tail logs
sudo journalctl -u chatapp -f
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
./deploy/deploy-prod.sh <commit-sha>
```

This:
1. Confirms you want to deploy to production (interactive prompt)
2. Backs up production database
3. Downloads the artifact from GitHub Releases
4. Copies to production server
5. Unpacks candidate release
6. Starts on alternate port (4001) **without touching running traffic**
7. Runs health checks + smoke tests against candidate
8. **Only if healthy**, switches Nginx to new version
9. Monitors for 60 seconds
10. Updates `current` symlink
11. Keeps old version running on original port for instant rollback

### Immediate Rollback

If issues are detected after cutover:

```bash
# Revert Nginx traffic immediately (takes ~5 seconds)
ssh ubuntu@130.245.136.44 "
  sudo sed -i 's/localhost:4001/localhost:4000/' /etc/nginx/sites-available/chatapp
  sudo systemctl reload nginx
"
```

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

1. **Nginx `worker_connections`** (in `/etc/nginx/nginx.conf` inside the `events { }` block). The repo’s [`infrastructure/nginx/nginx.conf`](../infrastructure/nginx/nginx.conf) uses **4096**; default distro configs are often **768** and can bottleneck WebSocket fan-in. After editing, `sudo nginx -t && sudo systemctl reload nginx`.

2. **`LimitNOFILE`** for the Node process: the systemd template [`deploy/chatapp-template.service`](./chatapp-template.service) sets **65535** — ensure production units match.

3. **Swap thrash**: sustained **swap in/out** (not just “some swap used”) hurts latency. If `vmstat` shows high `si`/`so` during tests, add RAM or reduce colocated services; application-level pagination only helps when clients use smaller pages.

4. **Access logs**: keep **JWTs out of nginx access logs** (do not log the `Authorization` header).

### During Deploy

- Old and new versions coexist briefly
- Only switch traffic after new version starts successfully
- If new version crashes during startup → old version untouched

## Observability

### Logs

```bash
# SSH to production
ssh ssperrottet@136.114.103.71

# View recent logs
sudo tail -100 /var/log/chatapp-candidate.log
sudo journalctl -u chatapp -n 200 | less

# Monitor in real-time
sudo journalctl -u chatapp -f
```

### Health Monitoring

Set up alerting:
- Monitor `GET /health` every 30 seconds
- Alert if 503 or 5xx response
- Alert if timeout (service down)
- Set `ALERT_ENVIRONMENT=staging` on staging and `ALERT_ENVIRONMENT=production` on prod
- Put the matching `DISCORD_WEBHOOK_URL_STAGING=...` or `DISCORD_WEBHOOK_URL_PROD=...` in `/opt/chatapp/shared/.env`
- Redeploy or restart `alertmanager` + `prometheus` so Discord notifications go live
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
- **Staging logs**: SSH to staging, `journalctl -u chatapp -f` or `/var/log/*`
- **Prod logs**: SSH to `ssperrottet@136.114.103.71`, same

For architectural questions, refer to the main [README.md](../README.md).
