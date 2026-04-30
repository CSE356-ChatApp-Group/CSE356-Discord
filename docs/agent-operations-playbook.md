# Agent Operations Playbook

Status: operational
Owner: platform-operations
Last reviewed: 2026-04-30

Documentation hub: [`README.md`](README.md). This playbook is the end-to-end workflow for agents/operators diagnosing incidents and proposing improvements.

## Scope and goals

Use this when asked to:

- diagnose production/staging issues,
- SSH into hosts and gather evidence,
- inspect logs/metrics,
- profile performance bottlenecks,
- recommend and validate meaningful fixes.

This document is process-oriented. Canonical source data still lives in:

- topology and SSH users: [`infrastructure-inventory.md`](infrastructure-inventory.md)
- metrics and PromQL: [`operations-monitoring.md`](operations-monitoring.md)
- alert actions: [`runbooks.md`](runbooks.md)
- env semantics and defaults: [`env.md`](env.md)
- required deploy profile: [`../deploy/env/prod.required.env`](../deploy/env/prod.required.env), [`../deploy/env/staging.required.env`](../deploy/env/staging.required.env)

## 0) Fast routing by symptom

1. **Delivery misses / realtime complaints**
   - start: [`grading-delivery-semantics.md`](grading-delivery-semantics.md), [`realtime-delivery-contract.md`](realtime-delivery-contract.md)
   - then: `backend/src/websocket/server.ts`, fanout paths in `backend/src/messages/fanout/*`
2. **High latency / 5xx**
   - start: [`operations-monitoring.md`](operations-monitoring.md), [`runbooks.md`](runbooks.md)
   - then: DB pool metrics, Redis/fanout queue metrics, event loop lag
3. **Deploy/regression suspicion**
   - start: [`runbooks.md`](runbooks.md), [`../deploy/README.md`](../deploy/README.md)
   - verify current SHA + merged required env keys

## 1) Baseline triage workflow (always do in order)

1. **Define incident window**
   - absolute start/end UTC, affected endpoints/features, env (staging/prod).
2. **Confirm current deploy + profile**
   - current release/SHA on host
   - verify required env profile keys are present as expected.
3. **Collect metrics snapshot**
   - use `metrics-snapshot.sh` recipe from [`operations-monitoring.md`](operations-monitoring.md).
4. **Collect logs for same time window**
   - app worker logs, nginx errors, deploy events if relevant.
5. **Classify dominant bottleneck**
   - DB pool saturation vs Redis/fanout vs app CPU/event-loop vs client/bootstrap timing.
6. **Only then propose change**
   - smallest reversible patch/config first; include explicit success criteria.

## 2) SSH and host access workflow

Do not hardcode host IPs in new docs or recommendations; read them from [`infrastructure-inventory.md`](infrastructure-inventory.md).

### Production

- app vm1/vm2/vm3 + db + monitoring default to `ubuntu@...` (see inventory).
- if replica access requires jump host, use the inventory-provided pattern.

### Staging

- staging app/db default to `ssperrottet@...` (see inventory).

### Safety rules

- avoid destructive commands during diagnosis;
- gather read-only evidence first;
- if changing env/config, record what changed and rollback path.

## 3) Logs-first commands (copy/paste template)

Run on the relevant host role from inventory:

```bash
# service state (app hosts)
systemctl status 'chatapp@*'

# recent app logs
journalctl -u 'chatapp@*' -n 200 --no-pager

# nginx upstream failures (app/edge host)
grep -E 'upstream|no live upstreams|502|504' /var/log/nginx/error.log | tail -n 80

# deploy events in a known window (adjust timestamps)
journalctl -t chatapp-deploy --since '2026-04-30 16:00:00' --until '2026-04-30 17:00:00'
```

For alert-specific variants, use [`runbooks.md`](runbooks.md).

## 4) Metrics and profiling workflow

Use exact metric names and queries from [`operations-monitoring.md`](operations-monitoring.md); do not invent names.

### A) DB pressure profile

Evidence pattern:

- `pg_pool_waiting` high,
- `pg_pool_idle` near zero,
- request latency rising,
- pool circuit breaker rejects/503 increasing.

Likely actions:

- reduce expensive query pressure,
- tune queue/circuit settings carefully,
- adjust worker/pool sizing only with host capacity evidence.

### B) Redis/fanout profile

Evidence pattern:

- fanout queue depth/latency rising,
- retry/dead-letter signals,
- WS delivery delays while HTTP 201 may still pass.

Likely actions:

- inspect publish path and queue configuration,
- verify realtime profile keys (autosubscribe/fanout mode/blocking),
- avoid broad mode flips without metrics-backed reason.

### C) App CPU / event loop profile

Evidence pattern:

- event loop lag alerts,
- CPU saturation with broad route degradation.

Likely actions:

- identify hot endpoints,
- reduce synchronous expensive work,
- confirm not DB-bound first.

## 5) Meaningful improvement rubric (for agent proposals)

A recommendation is meaningful only if it includes:

1. **Observed evidence** (metrics + logs + time window),
2. **Root cause hypothesis** tied to code/config,
3. **Minimal change** (single knob or small patch),
4. **Success criteria** (specific metrics expected to improve),
5. **Rollback** (how to revert safely),
6. **Doc updates** if behavior/env contracts changed.

Reject vague recommendations like "scale up" or "increase limits" without measured bottleneck evidence.

## 6) Post-change validation checklist

1. Repeat the same snapshot queries over comparable load.
2. Confirm target metrics improved and no new regression alerts appeared.
3. Re-run relevant smoke checks / tests.
4. Update canonical docs:
   - env semantics in [`env.md`](env.md),
   - topology changes in [`infrastructure-inventory.md`](infrastructure-inventory.md),
   - incident guidance in [`runbooks.md`](runbooks.md),
   - troubleshooting queries in [`operations-monitoring.md`](operations-monitoring.md).

## 7) Anti-patterns (do not do)

- Do not treat `artifacts/load-tests/*.md` as canonical operations truth.
- Do not copy full env blocks into multiple docs.
- Do not attribute outages without synchronized metrics + logs in the same window.
- Do not change multiple independent knobs in one incident response step.
