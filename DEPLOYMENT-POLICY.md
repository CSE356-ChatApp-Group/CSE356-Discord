# Deployment Policy

## Principle

**Production deployments must never bypass verification.** Code is validated in staging before any production traffic shift happens.

## Three-Environment Strategy

```
DEV ──commit──> CI ────artifact───> STAGING ──manual──> PROD
             (build once)           (verify)          (cutover)
```

1. **Dev** (local): Developers test changes
2. **Staging** (Google Cloud VM): Exact production environment, full validation
3. **Production** (`ssperrottet@130.245.136.44`): Zero-downtime cutover with instant rollback

## Immutable Artifacts

A single immutable artifact is built once in CI and deployed to all environments:
- Built from locked `package-lock.json`
- Tagged with commit SHA
- Stored in GitHub Releases
- Same bits everywhere → no surprises

## Deployment Flow

### CI (automatic on merge to main)

1. Typecheck + lint + tests pass
2. Build backend and frontend with locked dependencies
3. Package artifact: `tarball(backend/dist, frontend/dist, migrations, package.json)`
4. Tag with commit SHA
5. Store in GitHub Releases

**No environment-specific builds.** Same artifact for staging and prod.

### Staging Deployment (manual, gated by approver)

```bash
./deploy/deploy-staging.sh <sha>
```

Process:
1. Download prebuilt artifact
2. Unpack on staging VM
3. Start on candidate port (4001) **without touching traffic**
4. Health + smoke tests
5. If healthy, switch Nginx → new version
6. Keep old version running
7. Monitor for 30 seconds

**If anything fails, old version still runs.** No service disruption.

Staging validates:
- Artifact integrity
- Database migrations
- Redis connectivity
- WebSocket startup
- Presence aggregation
- API endpoints
- Integration behavior

### Production Deployment (manual, explicit approval required)

```bash
./deploy/deploy-prod.sh <sha>
```

Process:
1. **Staging must have deployed and passed first**
2. Interactive confirmation prompt (requires human approval)
3. Database backup (automatic)
4. Download exact same artifact
5. Unpack as new release directory
6. Start on alternate port (4001) **without touching running traffic**
7. Full health + smoke checks against isolated candidate
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
4. **Staging must validate before prod**: No prod deploy without staging sign-off.
5. **Database backups before prod**: Automatic, but verified.
6. **Rollback must be instant**: Traffic switch is ~5 seconds, process already running.
7. **No in-place overwrites**: Always new directories + symlink switch.
8. **Manual approval required for prod**: No auto-deployments to production.

## Who Can Deploy

- **Staging**: Any developer (automatic post-merge, or manual with same script)
- **Production**: On-call engineer or team lead (must approve interactively)

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
