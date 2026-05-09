# Team Reflection and Contributions

This file records team responsibilities, major contributions, coordination, and deadline process for the final project submission. Entries marked `TODO` are intentionally left for the named team member or project team to complete before submission.

## Team Members

| Name | Email | Main responsibilities | Major contributions and tasks |
|------|-------|-----------------------|-------------------------------|
| Angela Lee | `angela.lee.1@stonybrook.edu` | TODO | TODO |
| Jensen Jacob | `jensen.jacob@stonybrook.edu` | Core messaging and realtime product features, DM/group-DM behavior, permissions, attachments/object storage integration, websocket delivery reliability, and later production deploy / websocket-tier scaling work. | Built and refined core chat features across channels, DMs, presence, permissions, attachments, and realtime updates; then improved websocket reliability, deploy safety, monitoring, and dedicated websocket-tier rollout under production load. |
| Jiaxin Xie | `jiaxin.xie@stonybrook.edu` | Authentication and access flows (OAuth/OIDC), requirement-verification and API-contract alignment, presence/unread/search correctness fixes, and reliability/performance work across Redis/cache/replay paths. | Implemented multi-provider auth support, led requirement-driven bug fixes and behavior alignment (presence, DM/group behavior, unread logic, search scope), moved Redis into a dedicated VM, and improved cross-instance cache/replay reliability under load. |
| Sam Perrottet (`ssperrottet`) | `samuel.perrottet@stonybrook.edu` | Backend/platform lead, performance and operations lead, production deployment coordination, documentation organization. | Led backend scalability work across message posting, realtime fanout, Redis/Postgres interactions, read paths, search tuning, load testing, observability, runbooks, CI/release/deploy reliability, and multi-VM production rollout. |

## Sam Perrottet Contribution Summary

Sam was the primary implementation and operations contributor for the final scaling phase of the project. His work covered most of the backend performance loop: identifying bottlenecks from production metrics and load tests, implementing fixes across Postgres/Redis/WebSocket/search paths, deploying changes through canaries, and updating runbooks and documentation so the system could be operated and debugged by the rest of the team.

Sam's work, based on repository history and the current documentation/code layout, centered on making the application operate like a production messaging system under load:

- Designed and tuned backend hot paths for messages, conversations, read receipts, presence, WebSocket bootstrap, Redis fanout, and cache behavior.
- Improved horizontal realtime delivery through Redis Pub/Sub, logical user fanout, WebSocket readiness, pending replay, backpressure instrumentation, and generated-client compatibility.
- Investigated scaling bottlenecks using route p95/p99 metrics, Prometheus snapshots, load-test artifacts, `pg_stat_statements`, Redis metrics, deployment logs, and production canaries.
- Optimized Postgres and Redis usage through read-replica routing, query round-trip reductions, cache invalidation fixes, fanout target caching, idempotency behavior, and overload/pool guardrails.
- Tuned search behavior across the migration from Postgres full-text search to Meilisearch and then OpenSearch, including fallback bounds, candidate/recheck metrics, write-path lag, and production search configuration.
- Built and maintained monitoring and operations material: Prometheus/Grafana dashboards, alert rules, metric snapshots, Loki/Tempo guidance, runbooks, risk registers, and operational documentation indexes.
- Strengthened CI, packaging, deploy, and rollback workflows with immutable release artifacts, build-SHA verification, deploy locks, nginx/WebSocket drain handling, VM canary rollout, fleet parity checks, and multi-VM production scripts.
- Organized documentation so env profiles, topology, metrics, Redis keys, runbooks, architecture contracts, and benchmark evidence have canonical locations instead of duplicated stale copies.

## Jensen Jacob Contribution Summary

Jensen contributed heavily to both the product-building phase and the later scaling/reliability phase of the project. Early on, Jensen did substantial implementation work on the actual application features users interact with directly, especially around messaging, DMs, presence, permissions, attachments, and websocket-driven realtime behavior. Later, Jensen also contributed significantly to debugging and hardening the system under load in production.

Jensen's work centered on both building the collaborative product surface and making its realtime behavior reliable:

- Implemented and refined core application features including channel and conversation permission checks, websocket event handling for channel creation/DMs/message delivery, presence initialization, and frontend chat UX improvements such as image sending and search-result navigation.
- Added and stabilized media/storage features by integrating MinIO/object-storage-backed message attachments and avatar storage into the application flow.
- Built and corrected community collaboration features including admin roles, channel visibility switching, realtime visibility updates, channel-creation fanout, member-left/member-added updates, and stale community-state fixes.
- Improved messaging and realtime correctness by fixing dropped websocket deliveries after successful writes, tightening subscribe/unsubscribe behavior, reducing duplicate presence updates, and removing unnecessary read-receipt fanout.
- Refined related read/search/realtime user flows where correctness depended on coordinated HTTP, websocket, and cache behavior, including unread-count paths, message-target lookup efficiency, reconnect delivery handling, and recent-connect replay behavior.
- Contributed to the later production scaling phase through websocket replay/delivery fixes, dedicated websocket upstream routing, websocket VM rollout, websocket-focused monitoring/debug logging, multi-VM nginx safety improvements, and deploy failure recovery.
- Added and relied on observability hooks that made production debugging possible, including websocket-focused logging, route/search fallback metrics, session/auth metrics, and monitoring support for the dedicated websocket hosts so the team could compare app VMs and websocket VMs directly during incidents.
- Investigated live incidents using Prometheus metrics, nginx/app logs, canary deploys, and route-level behavior, especially around websocket reconnect gaps, delivery misses, deploy-related routing failures, search fallback behavior, and production rollout stability.

## JiaXin Angel Xie Contribution Summary

JiaXin (Angel) Xie contributed across all three phases of the project: core access/auth setup, requirement-verification and behavior-correction work, and production reliability/performance hardening. Repository history shows direct ownership of fixes around OAuth/OIDC onboarding, presence and unread correctness, DM/group invite semantics, scoped search behavior, reconnect reliability, and Redis/cache scaling paths.

Angel's main contributions included:

- Early development phase:
- Designed and set up authentication support for Google, GitHub, and the course OAuth2/OpenID Connect provider (including OpenID OAuth integration commits).
- Set up HTTPS for the application with Let's Encrypt for secure production/staging access.
- Testing and verification phase:
- Drove requirement conformance checks against grader/API-contract expectations and documented/fixed requirement mismatches through code and test updates.
- Corrected inconsistent presence behavior and later switched bulk presence hydration to `POST /presence/bulk` to avoid long-URI/query-size failures and improve correctness.
- Fixed DM/group-DM behavior to match project requirements, including invite fanout and invite/leave policy clarifications aligned with Piazza guidance.
- Reworked unread-message tracking so channel and DM unread counts behave uniformly, including a dedicated unread-count query path and websocket-compatible updates.
- Fixed failing empty-search/test-scope behavior by enforcing requirement-correct search boundaries (community-wide or conversation-wide scopes).
- Optimization and reliability phase:
- Migrated Redis usage to a dedicated Redis VM for better scalability, isolation of concerns, and operational visibility.
- Consolidated cache/Redis-side logic (distributed singleflight, stale-while-revalidate, version-aware cache keys, roster/read-path caching) to reduce DB query pressure and prevent cross-instance stampedes.
- Investigated and fixed race-prone realtime paths (notably websocket reconnect/replay/readiness behavior) to improve read/write synchronization and delivery consistency under load.

## Team Process

The team initially held weekly meetings to discuss progress, current blockers, and continuing issues. After the first few weeks, attendance dropped off significantly, so the team decided to stop holding regular meetings. Most day-to-day communication happened by text in a group chat, with larger project goals, deadlines, and milestone status tracked in a shared coordination document.

We used CI with automated tests to catch regressions before merge, and production changes were deployed manually with canary rollouts when possible to reduce risk. Because the system had several interacting performance-sensitive pieces, performance regressions were still common when changes had unforeseen side effects. The team used load-test results, metrics, logs, and targeted follow-up fixes to identify and address those regressions quickly.
