# Deployment Safety Runbook

Safe, predictable deployments to production (3 VMs, 16 workers).

## Quick Reference

```bash
# 1. Validate environment is ready
./deploy/validate-deploy.sh --prod

# 2. Preview deployment plan
./deploy/deploy-prod-multi.sh <sha> --dry-run

# 3. Run deployment
./deploy/deploy-prod-multi.sh <sha>

# 4. Verify post-deploy
ssh ubuntu@130.245.136.44 "cat /opt/chatapp/config/deployment-params.json | jq '.current'"
```

## Prerequisites

✅ PostgreSQL max_connections upgraded to 1600:
```bash
DB_SSH=ubuntu@130.245.136.21 ALLOW_DB_RESTART=true ./deploy/tune-remote-db-postgres.sh
```

✅ Release artifact built and available on GitHub:
```bash
gh release list | head -1
```

## Detailed Workflow

### Phase 1: Pre-Flight Validation

```bash
./deploy/validate-deploy.sh --prod
```

**What it checks:**
- SSH connectivity to all 3 VMs and DB host
- PostgreSQL max_connections >= 1600
- Disk space >= 10GB on each VM
- Pool sizing calculations

**If validation fails:** Fix the issue before proceeding (don't skip this step)

Example: PostgreSQL not upgraded
```bash
ERROR: PostgreSQL max_connections=500 but need >= 1600
Run: DB_SSH=ubuntu@130.245.136.21 ALLOW_DB_RESTART=true ./deploy/tune-remote-db-postgres.sh
```

### Phase 2: Dry Run (Review Plan)

```bash
./deploy/deploy-prod-multi.sh e0c97f7 --dry-run
```

Output shows:
- Expected release and phases
- Pool sizing calculations
- Worker topology (4+6+6)
- PostgreSQL requirements

**Verify this matches your expectations before proceeding**

### Phase 3: Execute Deployment

```bash
./deploy/deploy-prod-multi.sh e0c97f7
```

**What happens:**
1. Phase -1: Final PostgreSQL verification
2. Phase 0: Deploy VM3 (6 workers) - most isolated, lowest risk
3. Phase 0.5: Verify VM3 workers healthy
4. Phase 1: Deploy VM2 (6 workers)
5. Phase 2: Verify VM2 workers healthy  
6. Phase 3: Deploy VM1 (4 workers + shared services)
7. Phase 4: Verify upstream entries preserved
8. Phase 5: Final health check all 16 workers

**Deployment typically takes 10-15 minutes**

### Phase 4: Post-Deploy Verification

```bash
# Check deployed version on each VM
ssh ubuntu@130.245.136.44 "cat /opt/chatapp/config/deployment-params.json | jq '.current | {release, configuration}'"
```

Example output:
```json
{
  "release": {
    "commit": "e0c97f7",
    "message": "Fix prod-nginx-audit to accept round_robin..."
  },
  "configuration": {
    "pool_size": 490,
    "pg_max_connections": 1600,
    "workers": 4,
    "vcpu": 8
  }
}
```

**All 16 workers should report status "ok":**
```bash
for vm in 130.245.136.44 130.245.136.137 130.245.136.54; do
  echo "VM: $vm"
  ssh ubuntu@$vm "for p in 4000 4001 4002 4003 4004 4005; do curl -sf http://127.0.0.1:\$p/health 2>/dev/null | jq -c '.status' 2>/dev/null || true; done"
done
```

## If Deployment Fails

### During VM3 (Phase 0)
- **Safest point to abort** - only VM3 affected, VM1/VM2 unchanged
- Workers should rollback automatically
- No production impact expected

### During VM2 (Phase 1)
- VM3 workers (6) are already on new code
- VM1 still has previous release
- Some degradation expected but not critical
- Can continue or rollback

### During VM1 (Phase 3)
- **Most critical** - if this phase fails:
  - Some VM1 workers (4) may be in flux
  - VM2+VM3 workers (12) are already updated
  - System operates on 12 workers (degraded but functional)
- Manual rollback on VM1:
  ```bash
  ssh ubuntu@130.245.136.44 "sudo systemctl stop chatapp@{4000..4003}"
  # Will auto-restart on previous release
  ```

### Manual Rollback (If Needed)

```bash
# Full rollback to previous release
./deploy/deploy-prod.sh <previous-sha> --rollback
```

**--rollback flag:**
- Skips artifact download/build
- Reuses existing release on disk
- Only rolls the running code (fast)
- Completes in 2-3 minutes

## Debugging with Deployment Logs

Deployment events are logged to each VM at `/opt/chatapp/logs/deploy-<sha>.jsonl` (one JSON object per line):

```bash
# View all events for a deployment
ssh ubuntu@130.245.136.44 "cat /opt/chatapp/logs/deploy-e0c97f7.jsonl | jq ."

# Check specific phase
ssh ubuntu@130.245.136.44 "cat /opt/chatapp/logs/deploy-e0c97f7.jsonl | jq 'select(.phase == \"pool-sizing\")'"
```

## Pool Sizing Reference

Pool sizing formula: `max(60, min(500, (vCPU × 50) + ((workers-1) × 30)))`

**Current production configuration:**
| VM | vCPU | Workers | Pool Size | Workers Served |
|----|------|---------|-----------|---|
| VM1 | 8 | 4 | 490 | 4 local |
| VM2 | 8 | 6 | 500 | 6 on VM2 |
| VM3 | 8 | 6 | 500 | 6 on VM3 |
| **Total** | 24 | 16 | **1490** | **All** |

**PostgreSQL Configuration:**
- `max_connections = 1600` (headroom for all 3 pools + admin)
- `work_mem` calculated per VM based on available RAM

## Advanced: Testing Pool Sizing

```bash
# Run integration tests
python3 deploy/test-pool-calculator.py

# Calculate for custom specs
./deploy/pool-calculator.py --vcpu=4 --workers=2 --explain
```

## Troubleshooting

### Issue: "PostgreSQL max_connections must be >= 1500"
**Fix:** Upgrade PostgreSQL before deploying
```bash
DB_SSH=ubuntu@130.245.136.21 ALLOW_DB_RESTART=true ./deploy/tune-remote-db-postgres.sh
```

### Issue: nginx audit fails with "least_conn not present"
**Fix:** This is expected during rolling restart (uses round_robin, switches to least_conn after)
- The deploy script will handle this automatically
- If stuck, check `/etc/nginx/sites-available/chatapp` on prod VM

### Issue: Disk space too low
**Fix:** Cleanup old releases (deploy script does this automatically)
```bash
ssh ubuntu@130.245.136.44 "cd /opt/chatapp/releases && ls -t | tail -n +4 | xargs rm -rf"
```

### Issue: One worker unhealthy post-deploy
**Fix:** Usually temporary; restart the worker
```bash
ssh ubuntu@130.245.136.44 "sudo systemctl restart chatapp@4000"
```

## Monitoring Post-Deploy

**Watch for latency improvement** in Grafana "Search Performance" dashboard:
- p95 latency should drop to 200-300ms (from 300-600ms baseline)
- This indicates per-VM PgBouncer is reducing cross-VM network latency

**Check pool utilization** via PgBouncer metrics:
- Each pool should be ~15-20% utilized
- If > 50%, may indicate need for more workers

**Review deployment events:**
```bash
ssh ubuntu@130.245.136.44 "tail -20 /opt/chatapp/logs/deploy-*.jsonl | jq ."
```

## New Tools Reference

| Tool | Purpose | Usage |
|------|---------|-------|
| `pool-calculator.py` | Calculate optimal pool sizing | `./pool-calculator.py --vcpu=8 --workers=6 --explain` |
| `validate-deploy.sh` | Pre-flight environment checks | `./validate-deploy.sh --prod` |
| `test-pool-calculator.py` | Regression tests for pool sizing | `python3 test-pool-calculator.py` |
| `record-deployment-config.py` | Audit trail of deployments | Called automatically by deploy script |
| `record-deploy-event.py` | Structured logging of deploy phases | Called automatically by deploy script |

## Support & Questions

If deployment fails:
1. Check `/opt/chatapp/logs/deploy-*.jsonl` for what phase failed
2. Run `./deploy/validate-deploy.sh --prod` to diagnose environment issues
3. Review deployment logs for specific error messages
4. Check individual VM status: `ssh ubuntu@<vm> "systemctl status chatapp@4000"`

---

**Last Updated:** April 21, 2026  
**Maintainer:** Infrastructure Team
