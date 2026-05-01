# Documentation

Start here for **where to look** and **how to keep docs from going stale**.

## Single sources of truth

| Topic | Canonical location | Do not duplicate |
|--------|--------------------|------------------|
| **Prod/staging required env (merged profile)** | [`deploy/env/prod.required.env`](../deploy/env/prod.required.env), [`deploy/env/staging.required.env`](../deploy/env/staging.required.env) | Long env blocks in runbooks, copilot instructions, or chat — **link** and mention only **deltas** (overrides) |
| **All tunables (semantics, defaults)** | [`docs/env.md`](env.md) + [`.env.example`](../.env.example) | Copy-paste full variable lists into multiple files |
| **Host topology, SSH users, IP intent** | [`docs/infrastructure-inventory.md`](infrastructure-inventory.md) | IP lists in slides, one-off runbooks (link to inventory; update inventory when facts change) |
| **Metric names, PromQL, incident workflow** | [`docs/operations-monitoring.md`](operations-monitoring.md) + [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) | Ad-hoc metric names in issues without checking `backend/src/utils/metrics.ts` |
| **Backend hotspots (refactor / throughput risk ordering)** | [`docs/backend-hotspots.md`](backend-hotspots.md) | Duplicating the full ranked table in issues — **link** this doc |
| **Redis key / Pub/Sub topic patterns (operators’ map)** | [`docs/redis-key-map.md`](redis-key-map.md) | Duplicating key lists in runbooks — **link** this doc and mention only deltas |
| **Alert / on-call playbooks** | [`docs/runbooks.md`](runbooks.md) | — |
| **Agent diagnosis + profiling workflow** | [`docs/agent-operations-playbook.md`](agent-operations-playbook.md) | Ad-hoc debugging checklists scattered across unrelated docs |
| **Deploy pipeline & CI gates** | [`deploy/README.md`](../deploy/README.md) | — |
| **Realtime delivery contract (code pointers)** | [`docs/architecture/realtime-delivery-contract.md`](architecture/realtime-delivery-contract.md) | File paths to handlers — **grep or open file** before citing; link this doc instead of duplicating tables |
| **WebSocket profile / generated client** | [`backend/src/websocket/profile.ts`](../backend/src/websocket/profile.ts) | “Default” claims without checking **unset** behavior vs **required env** |

**Rule:** If two docs disagree, **code + git-tracked `deploy/env/*.required.env` win**; then update the prose doc.

### Code hotspots (when you are changing behavior, not just docs)

| Area | Main entry points |
|------|---------------------|
| **WebSocket / subscribe / presence** | `backend/src/websocket/server.ts`, `backend/src/websocket/profile.ts` |
| **Channel message fanout** | `backend/src/messages/fanout/channelRealtimeFanout.ts`, `backend/src/messages/fanout/messagePostFanoutAsync.ts` |
| **DM / conversation fanout** | `backend/src/messages/fanout/conversationFanout.ts` |
| **Read state & receipts** | `backend/src/messages/lib/readReceiptState.ts`, `backend/src/messages/readState/batchReadState.ts` (Redis → PG flush), `backend/src/messages/readReceipt/readReceiptHttpCore.ts` (PUT read / batch-read), `backend/src/messages/routes/read.ts` (Express registration) |
| **Search** | `backend/src/search/client.ts`, `backend/src/search/routes/get.ts` |
| **Metrics & overload** | `backend/src/utils/metrics.ts`, `backend/src/utils/overload.ts` |

Prefer linking these paths from [`architecture/realtime-delivery-contract.md`](architecture/realtime-delivery-contract.md) instead of maintaining parallel tables in multiple files.

### IDE / automation

Workspace notes live under [`.cursor/rules/`](../.cursor/rules/) (e.g. infrastructure inventory, operations discipline). Repo-wide agent entry: **[`AGENTS.md`](../AGENTS.md)**.

---

## By audience

| If you are… | Read first |
|-------------|------------|
| **Operating prod / staging** | [`runbooks.md`](runbooks.md), [`operations-monitoring.md`](operations-monitoring.md), [`infrastructure-inventory.md`](infrastructure-inventory.md), [`deploy/README.md`](../deploy/README.md) |
| **Acting as an ops/debug agent** | [`agent-operations-playbook.md`](agent-operations-playbook.md), [`operations-monitoring.md`](operations-monitoring.md), [`infrastructure-inventory.md`](infrastructure-inventory.md) |
| **Debugging delivery / graders** | [`architecture/grading-delivery-semantics.md`](architecture/grading-delivery-semantics.md), [`architecture/realtime-delivery-contract.md`](architecture/realtime-delivery-contract.md) |
| **Changing env or capacity** | [`env.md`](env.md), [`deploy/env/`](../deploy/env/), host sizing in [`infrastructure-inventory.md`](infrastructure-inventory.md) |
| **On-call / incident depth** | [`slos-and-chaos.md`](slos-and-chaos.md), [`verification-risk-register.md`](verification-risk-register.md) |

---

## Agent traversal protocol

1. Classify requested docs as **operational**, **playbook**, or **design/history** before making edits.
2. For behavior claims, confirm with code hotspots in this file (or tests) first.
3. For env and deployment claims, treat [`deploy/env/*.required.env`](../deploy/env/) and [`infrastructure-inventory.md`](infrastructure-inventory.md) as authoritative.
4. Update canonical docs first; keep secondary docs to links + short context.
5. Treat markdown under `artifacts/` as generated historical output, not operational source-of-truth.

---

## Doc types (maintenance expectations)

| Label | Meaning |
|-------|---------|
| **Operational** | Expected current; update when behavior or env contracts change. |
| **Playbook** | Procedure may evolve; keep steps and links working. |
| **Design / rollout history** | May describe past stages; **check date and required-env** before treating as “how prod works today.” |

**Design / rollout examples:** [`history/plan-recent-connect-rollout.md`](history/plan-recent-connect-rollout.md), [`architecture/architecture-channel-first-realtime.md`](architecture/architecture-channel-first-realtime.md), [`history/remove-channels-last-message-hot-path.md`](history/remove-channels-last-message-hot-path.md), [`history/canary-read-receipt-insert-lock-shedding.md`](history/canary-read-receipt-insert-lock-shedding.md).

---

## Folder buckets

Organize navigation by function via subdirectory indexes (keep canonical operational docs at top-level paths to avoid breaking automation):

- **Operations index**: [`docs/operations/README.md`](operations/README.md)
- **Architecture / contracts index**: [`docs/architecture/README.md`](architecture/README.md)
- **History / rollout notes index**: [`docs/history/README.md`](history/README.md)

---

## Metadata convention

Operational docs should include near the top:

- `Status: operational`
- `Owner: <team-or-role>`
- `Last reviewed: YYYY-MM-DD`

Use this lightweight header to prevent stale docs without adding heavy process.

---

## All markdown files (repo map)

| Path | Role |
|------|------|
| [`AGENTS.md`](../AGENTS.md) | Short entry for contributors / coding agents → points here |
| [`README.md`](../README.md) | Overview, local quick start, API cheat sheet → link here for depth |
| [`deployment-runbook.md`](../deployment-runbook.md) | Deployment operations |
| [`deployment-policy.md`](../deployment-policy.md) | Policy |
| [`deploy/README.md`](../deploy/README.md) | CI, artifacts, staging/prod flow |
| [`deploy/staging-drill-checklist.md`](../deploy/staging-drill-checklist.md) | Staging drill |
| [`deploy/fail2ban/README.md`](../deploy/fail2ban/README.md) | fail2ban |
| [`docs/agent-operations-playbook.md`](agent-operations-playbook.md) | End-to-end diagnosis and improvement workflow for agents |
| [`frontend/README.md`](../frontend/README.md) | Frontend |
| [`load-tests/README.md`](../load-tests/README.md) | Load tests |
| [`ansible/README.md`](../ansible/README.md) | Ansible |
| `artifacts/load-tests/*.md` | Generated run outputs (historical snapshots; not canonical operations docs) |
| **This directory** | See table below |

### `docs/` reference table

| File | Type |
|------|------|
| [`env.md`](env.md) | Operational — env catalog |
| [`infrastructure-inventory.md`](infrastructure-inventory.md) | Operational — topology (update with infra changes) |
| [`operations-monitoring.md`](operations-monitoring.md) | Operational — metrics & queries |
| [`redis-key-map.md`](redis-key-map.md) | Operational — Redis keys & fanout topics (reference) |
| [`runbooks.md`](runbooks.md) | Operational — incident response |
| [`agent-operations-playbook.md`](agent-operations-playbook.md) | Operational — agent diagnosis/profiling workflow |
| [`architecture/grading-delivery-semantics.md`](architecture/grading-delivery-semantics.md) | Operational / course |
| [`architecture/realtime-delivery-contract.md`](architecture/realtime-delivery-contract.md) | Operational — delivery map |
| [`architecture/websocket-generated-client-parity.md`](architecture/websocket-generated-client-parity.md) | Operational — client/server parity |
| [`architecture/ws-horizontal-scale.md`](architecture/ws-horizontal-scale.md) | Playbook / architecture |
| [`architecture/db-scaling-messages.md`](architecture/db-scaling-messages.md) | Design / scaling notes |
| [`history/performance-baseline-pack.md`](history/performance-baseline-pack.md) | Benchmarks |
| [`slos-and-chaos.md`](slos-and-chaos.md) | SLO / chaos |
| [`verification-risk-register.md`](verification-risk-register.md) | Risk register |
| [`history/plan-recent-connect-rollout.md`](history/plan-recent-connect-rollout.md) | Rollout history / playbook |
| [`architecture/architecture-channel-first-realtime.md`](architecture/architecture-channel-first-realtime.md) | Target architecture |
| [`history/remove-channels-last-message-hot-path.md`](history/remove-channels-last-message-hot-path.md) | Design proposal |
| [`history/canary-read-receipt-insert-lock-shedding.md`](history/canary-read-receipt-insert-lock-shedding.md) | Canary note |

### Subdirectory indexes

| Directory | Purpose |
|------|------|
| [`docs/operations/`](operations/) | Operational runbooks and ops-oriented references |
| [`docs/architecture/`](architecture/) | Delivery contracts and architecture/scaling references |
| [`docs/history/`](history/) | Rollout history, benchmarks, and superseded plans |

---

## When you change the codebase

1. **New or renamed env var** — Add to [`.env.example`](../.env.example) and describe semantics in [`env.md`](env.md). If prod/staging must pin it, add to [`deploy/env/*.required.env`](../deploy/env/).
2. **New metric** — Export in `backend/src/utils/metrics.ts` (and related); document name/purpose in [`operations-monitoring.md`](operations-monitoring.md) if operators need it.
3. **Behavioral contract (realtime, reads, search)** — Update [`architecture/realtime-delivery-contract.md`](architecture/realtime-delivery-contract.md) or tests-first; link from [`runbooks.md`](runbooks.md) only if on-call needs it.
4. **Infra (VM, IP, provider)** — Update [`infrastructure-inventory.md`](infrastructure-inventory.md) in the **same** change set.
5. **Doc consistency guardrail** — Run `npm run docs:check` before opening a PR that modifies docs.
6. **Large refactor / file splits** — Follow [`refactor-acceptance-gates.md`](refactor-acceptance-gates.md) (tests, deploy guards, observability parity).

---

## Optional: copilot / AI context

Prefer **[`AGENTS.md`](../AGENTS.md)** as the stable entry for automation (tables link here). [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) should stay **short** and point to this file + `env.md` + `infrastructure-inventory.md` instead of duplicating env profiles.
