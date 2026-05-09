# Team Reflection and Contributions

This file records team responsibilities, major contributions, coordination, and deadline process for the final project submission. Entries marked `TODO` are intentionally left for the named team member or project team to complete before submission.

## Team Members

| Name | Email | Main responsibilities | Major contributions and tasks |
|------|-------|-----------------------|-------------------------------|
| Angela Lee | `angela.lee.1@stonybrook.edu` | TODO | TODO |
| Jensen Jacob | `jensen.jacob@stonybrook.edu` | TODO | TODO |
| Jiaxin Xie | `jiaxin.xie@stonybrook.edu` | TODO | TODO |
| Samuel Perrottet (`ssperrottet`) | `samuel.perrottet@stonybrook.edu` | Backend/platform lead, performance and operations lead, production deployment coordination, documentation organization. | Led backend scalability work across message posting, realtime fanout, Redis/Postgres interactions, read paths, search tuning, load testing, observability, runbooks, CI/release/deploy reliability, and multi-VM production rollout. |

## Samuel Perrottet Contribution Summary

Samuel's work, based on repository history and the current documentation/code layout, centered on making the application operate like a production messaging system under load:

- Designed and tuned backend hot paths for messages, conversations, read receipts, presence, WebSocket bootstrap, Redis fanout, and cache behavior.
- Improved horizontal realtime delivery through Redis Pub/Sub, logical user fanout, WebSocket readiness, pending replay, backpressure instrumentation, and generated-client compatibility.
- Investigated scaling bottlenecks using route p95/p99 metrics, Prometheus snapshots, load-test artifacts, `pg_stat_statements`, Redis metrics, deployment logs, and production canaries.
- Optimized Postgres and Redis usage through read-replica routing, query round-trip reductions, cache invalidation fixes, fanout target caching, idempotency behavior, and overload/pool guardrails.
- Tuned search behavior across Postgres full-text search and Meili/OpenSearch paths, including fallback bounds, candidate/recheck metrics, write-path lag, and production search configuration.
- Built and maintained monitoring and operations material: Prometheus/Grafana dashboards, alert rules, metric snapshots, Loki/Tempo guidance, runbooks, risk registers, and operational documentation indexes.
- Strengthened CI, packaging, deploy, and rollback workflows with immutable release artifacts, build-SHA verification, deploy locks, nginx/WebSocket drain handling, VM canary rollout, fleet parity checks, and multi-VM production scripts.
- Organized documentation so env profiles, topology, metrics, Redis keys, runbooks, architecture contracts, and benchmark evidence have canonical locations instead of duplicated stale copies.

## Team Process

The team held weekly meetings to discuss progress, current blockers, and continuing issues. Most day-to-day communication happened by text in a group chat, with larger project goals, deadlines, and milestone status tracked in a shared coordination document.

We used CI with automated tests to catch regressions before merge, and production changes were deployed manually with canary rollouts when possible to reduce risk. Because the system had several interacting performance-sensitive pieces, performance regressions were still common when changes had unforeseen side effects. The team used load-test results, metrics, logs, and targeted follow-up fixes to identify and address those regressions quickly.
