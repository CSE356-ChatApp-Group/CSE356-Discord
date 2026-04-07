# Deployment Policy

## Principle

**Production deployments must never bypass verification.** Code is validated in staging before any production traffic shift happens.

## Three-Environment Strategy

```
DEV ──PR──> CI (tests+build)
            │
 merge ───> main: package artifact ──auto SSH──> STAGING
            │                                      │
            ├─ Playwright E2E (@staging)           │
            ├─ API contract harness (41 checks)   │
            └─ (scheduled) k6 slo / nightly E2E   │
                                                   │
 manual / GitHub "Manual Deploy" workflow ───────> PROD
```

1. **Dev** (local): Developers test changes
2. **Staging** (Google Cloud VM): Exact production environment, full validation
3. **Production** (`ubuntu@130.245.136.44`): Zero-downtime cutover with instant rollback

## Immutable Artifacts

A single immutable artifact is built once in CI and deployed to all environments:
- Built from locked `package-lock.json`
- Tagged with commit SHA
- Stored in GitHub Releases
- Same bits everywhere → no surprises

## Deployment Flow

### CI (automatic on merge to main)

Workflow: [`.github/workflows/ci-deploy.yml`](.github/workflows/ci-deploy.yml).

1. Validate deploy shell scripts + Node smoke helpers (`node --check`)
2. Backend + frontend typecheck, unit tests, production builds
3. Package artifact: `tarball(backend/dist, frontend/dist, migrations, package.json)`
4. GitHub Release tagged `release-<sha>` with the tarball
5. **Reusable deploy** job SSHs to staging and runs [`deploy/deploy-staging.sh`](deploy/deploy-staging.sh)
6. **Playwright** staging E2E (`@staging`) — must pass
7. **API contract harness** [`backend/scripts/api-contract-harness.cjs`](backend/scripts/api-contract-harness.cjs) — 41 course-aligned checks against staging HTTP+WS (set repo variable `API_CONTRACT_SSO_SKIP=1` if OIDC redirects cannot be reached from Actions)

**No environment-specific builds.** Same artifact for staging and prod.

**Scheduled / optional gates:** [`.github/workflows/staging-e2e-nightly.yml`](.github/workflows/staging-e2e-nightly.yml) (Playwright), [`.github/workflows/staging-load-gate.yml`](.github/workflows/staging-load-gate.yml) (weekly k6 `slo` — requires `LOADTEST_PASSWORD` secret for staging load accounts).

### Discord / Alertmanager capacity signals

Prometheus rules live in [`infrastructure/monitoring/alerts.yml`](infrastructure/monitoring/alerts.yml). Alertmanager posts to Discord from [`infrastructure/monitoring/alertmanager.yml`](infrastructure/monitoring/alertmanager.yml).

**Clear “you are near or past capacity” signals:**

- **Postgres pool** — `ChatAppPgPoolPressure` / `ChatAppPgPoolSevereSaturation` / `ChatAppPgPoolMostlyCheckedOut` (queue depth and checkout ratio).
- **HTTP edge behaviour** — `ChatAppHighHttpAbortRate` (timeouts / disconnects vs completed requests), `ChatAppHttpOverloadShedding` (event-loop lag 503s).
- **App + host** — existing CPU, memory, event-loop lag, 5xx rate, overload stage ≥2.
- **Redis** — exporter down, memory near `maxmemory`, elevated client count (requires [`redis_exporter`](https://github.com/oliver006/redis_exporter) and the `redis` job in `prometheus-host.yml`; staging deploy starts it).

After changing rules, copy `alerts.yml` to the monitoring host and restart Prometheus (or redeploy the monitoring stack) so Discord reflects the new definitions.

### Staging Deployment (automatic from CI + optional manual)

Every push to `main` deploys staging via CI. You can also redeploy any release SHA manually:

```bash
./deploy/deploy-staging.sh <sha>
```

Or GitHub **Actions → Manual Deploy → staging** ([`.github/workflows/deploy-manual.yml`](.github/workflows/deploy-manual.yml)).

Process:
1. Download prebuilt artifact (CI artifact or GitHub Release)
2. Unpack on staging VM
3. Start on candidate port (4001) **without touching traffic**
4. Health + shell smoke tests + **candidate WebSocket round-trip** ([`deploy/candidate-ws-smoke.cjs`](deploy/candidate-ws-smoke.cjs): register → channel → subscribe → POST message → `message:created` on WS)
5. If healthy, switch Nginx → new version
6. Keep old version running through the monitoring window
7. Monitor briefly

**If anything fails, old version still runs.** No application cutover.

Staging validates:
- Artifact integrity
- Database migrations
- Redis connectivity
- WebSocket startup + one realtime message delivery on the candidate port
- Presence aggregation
- API endpoints
- Integration behavior (Playwright + API contract in CI)

### Production Deployment (manual — never auto on merge)

```bash
./deploy/deploy-prod.sh <sha>
```

Or **Actions → Manual Deploy → prod** (passes `GITHUB_ACTIONS=true` so the script skips the interactive `y/N` prompt; use a **GitHub Environment** with required reviewers if you want a human gate in the UI).

Process:
1. **Staging must have deployed and passed first**
2. Interactive confirmation prompt when run from a laptop (skipped in GitHub Actions)
3. Database backup (automatic; failures log a warning — consider `DEPLOY_STRICT_BACKUP` if you add it)
4. Download exact same artifact
5. Unpack as new release directory
6. Start on alternate port (4001) **without touching running traffic**
7. Full health + smoke + **candidate WebSocket round-trip** on the new port
8. Only if healthy → switch Nginx to candidate
9. Monitor for 60 seconds
10. Update `current` symlink

**Old version stays running on port 4000 for instant rollback.**

## Safety Guarantees

### Before Cutover
- Two versions coexist
- New version is isolated on separate port
- No traffic yet
- Database is backed up
- All health checks pass

### During Cutover
- Nginx upstream switches (single sed + reload)
- Takes ~5 seconds
- WebSocket auto-reconnects on client side
- Presence re-syncs via heartbeat

### After Cutover
- Old version available at port 4000 for rollback
- New version has all traffic
- Monitor for 60 seconds
- If bad, revert Nginx upstream (instant)

### Rollback
```bash
# Revert Nginx upstream to old version
ssh ssperrottet@136.114.103.71 '
  sudo sed -i "s/localhost:4001/localhost:4000/" /etc/nginx/sites-available/chatapp
  sudo systemctl reload nginx
'
```
Takes ~5 seconds, old process resumes handling traffic.

## Health Checks

Every deployment verifies:
- Process is running
- HTTP `/health` returns 200
- Database is reachable
- Redis is reachable
- Basic API endpoints respond
- WebSocket process started

If any check fails, deployment stops and old version untouched.

## Release Directory Structure

```
/opt/chatapp/releases/
├── 2026-03-27T141500-abc123/    Old release
├── 2026-03-27T153200-def456/    Current (symlinked)
└── current → def456/             Symlink to active
```

Benefits:
- Old releases available for instant rollback
- No overwrites in place
- Can inspect failed releases later
- Easy cleanup (remove old dirs)
- Fast version switching (symlink)

## Constraints & Non-negotiables

1. **Same artifact everywhere**: CI builds once. Staging and prod use identical bits.
2. **No environment-specific code**: All config via `.env` files, not compile-time.
3. **Staging must match prod exactly**: Same Node version, same dependencies, same structure.
4. **Staging must validate before prod**: No prod deploy without staging sign-off (CI deploys staging on every `main` push; confirm Playwright + API contract jobs are green before prod).
5. **Database backups before prod**: Automatic, but verified.
6. **Rollback must be instant**: Traffic switch is ~5 seconds, process already running.
7. **No in-place overwrites**: Always new directories + symlink switch.
8. **Manual approval required for prod**: No auto-deployments to production.

## Who Can Deploy

- **Staging**: Any developer (automatic post-merge, or manual with same script)
- **Production**: On-call engineer or team lead (approve interactively when using the shell script, or via GitHub Environment protection when using **Manual Deploy**)

Staging is safe to deploy frequently for integration testing.
Production requires explicit confirmation.

## Monitoring Post-Deploy

After production cutover:
- Check `/health` on production endpoint
- Tail logs for errors
- Monitor error rate in APM
- Verify WebSocket connections stable
- Watch presence federation

Keep monitoring for at least 5–10 minutes before declaring success.

## Rollback Decision Tree

| Issue | Action |
|-------|--------|
| Health check fails (pre-cutover) | Stop deploy, old version untouched |
| Smoke test fails (pre-cutover) | Stop deploy, old version untouched |
| Error spike post-cutover (< 5 min) | Revert Nginx, instant rollback |
| Database issues | Restore backup, rollback, investigate |
| WebSocket issues | Rollback, clear frontend caches, redeploy |

All rollbacks are manual (explicit confirmation) to prevent thrashing.

## Migration Safety

- **Additive migrations only** near deploy time
- **Backward-compatible schema** required
- **Database backup before deploy** (automatic)
- **Test on staging first** (mandatory)
- **Never run migrations after cutover** (migrations before traffic switch)

## PostgreSQL tuning during deploy

[`deploy/deploy-staging.sh`](deploy/deploy-staging.sh) and [`deploy/deploy-prod.sh`](deploy/deploy-prod.sh) apply `ALTER SYSTEM` settings, then `pg_reload_conf()`. A **full `postgresql` restart** runs **only** when `pg_settings.pending_restart` is true (e.g. first-time `shared_preload_libraries`, or `max_connections` / `shared_buffers` changes). Routine deploys with unchanged tuning therefore avoid a cluster-wide restart and reduce user-visible DB blips.

## Example Timeline

```
10:00 - Merge PR to main
10:02 - CI finishes, artifact built & tagged
10:05 - Run: ./deploy/deploy-staging.sh <sha>
        Staging validates artifact
10:15 - Confirm staging is healthy
10:20 - Production approval requested
10:21 - On-call confirms, runs: ./deploy/deploy-prod.sh <sha>
        New version started on port 4001
        Health checks pass
        Nginx switches traffic
10:23 - Production live, old version on 4000
10:25 - Monitor, no errors
10:30 - Cleanup: stop old version
```

Total production downtime: **0 seconds** (zero-downtime cutover).

## Failure Modes

### Artifact download fails
→ Re-run deploy, check GitHub API access

### Migration fails on new version
→ Deployment stops, old version untouched
→ Investigate migration, fix, re-run

### Health check fails
→ Deployment stops, old version untouched
→ Inspect logs, fix code/config, rebuild, re-run

### Nginx reload fails
→ Deployment stops, keep investigating
→ Manual rollback may be needed if traffic was switched

### Old version crashes after rollback
→ Worst case: both versions down
→ Restore from backup or warm standby
→ Investigate, redeploy when ready

All failures are isolated to the deployment window; never cascade to running traffic.

## Success Criteria

A deploy is successful when:

- [ ] CI passed (all tests green)
- [ ] Artifact built (tagged with SHA)
- [ ] Staging deployed successfully
- [ ] Staging health + smoke tests passed
- [ ] Production approval given
- [ ] Production deployment script runs without errors
- [ ] Candidate health checks pass
- [ ] Traffic switches to new version
- [ ] Post-cutover monitoring shows no errors
- [ ] Error rate normal
- [ ] WebSocket connections stable
- [ ] Presence federation working

## Communicating Deployments

1. **Before deploy**: Notify team (Slack, email)
2. **During deploy**: Monitor actively, be ready to rollback
3. **After deploy**: Confirm success, log release notes

For production, have on-call person aware and available for 15 minutes post-cutover.
