# Documentation

Start here for **where to look** and **how to keep docs from going stale**.

## Single sources of truth

| Topic | Canonical location | Do not duplicate |
|--------|--------------------|------------------|
| **Prod/staging required env (merged profile)** | [`deploy/env/prod.required.env`](../deploy/env/prod.required.env), [`deploy/env/staging.required.env`](../deploy/env/staging.required.env) | Long env blocks in runbooks, copilot instructions, or chat — **link** and mention only **deltas** (overrides) |
| **All tunables (semantics, defaults)** | [`docs/env.md`](env.md) + [`.env.example`](../.env.example) | Copy-paste full variable lists into multiple files |
| **Host topology, SSH users, IP intent** | [`docs/infrastructure-inventory.md`](infrastructure-inventory.md) | IP lists in slides, one-off runbooks (link to inventory; update inventory when facts change) |
| **Metric names, PromQL, incident workflow** | [`docs/operations-monitoring.md`](operations-monitoring.md) + [`infrastructure/monitoring/alerts.yml`](../infrastructure/monitoring/alerts.yml) | Ad-hoc metric names in issues without checking `backend/src/utils/metrics.ts` |
| **Alert / on-call playbooks** | [`docs/runbooks.md`](runbooks.md) | — |
| **Agent diagnosis + profiling workflow** | [`docs/agent-operations-playbook.md`](agent-operations-playbook.md) | Ad-hoc debugging checklists scattered across unrelated docs |
| **Deploy pipeline & CI gates** | [`deploy/README.md`](../deploy/README.md) | — |
| **Realtime delivery contract (code pointers)** | [`docs/realtime-delivery-contract.md`](realtime-delivery-contract.md) | File paths to handlers — **grep or open file** before citing; link this doc instead of duplicating tables |
| **WebSocket profile / generated client** | [`backend/src/websocket/profile.ts`](../backend/src/websocket/profile.ts) | “Default” claims without checking **unset** behavior vs **required env** |

**Rule:** If two docs disagree, **code + git-tracked `deploy/env/*.required.env` win**; then update the prose doc.

### Code hotspots (when you are changing behavior, not just docs)

| Area | Main entry points |
|------|---------------------|
| **WebSocket / subscribe / presence** | `backend/src/websocket/server.ts`, `backend/src/websocket/profile.ts` |
| **Channel message fanout** | `backend/src/messages/fanout/channelRealtimeFanout.ts`, `backend/src/messages/fanout/messagePostFanoutAsync.ts` |
| **DM / conversation fanout** | `backend/src/messages/fanout/conversationFanout.ts` |
| **Read state & receipts** | `backend/src/messages/lib/readReceiptState.ts`, `backend/src/messages/readState/batchReadState.ts`, `backend/src/messages/routes/read.ts` |
| **Search** | `backend/src/search/client.ts`, `backend/src/search/routes/get.ts` |
| **Metrics & overload** | `backend/src/utils/metrics.ts`, `backend/src/utils/overload.ts` |

Prefer linking these paths from [`realtime-delivery-contract.md`](realtime-delivery-contract.md) instead of maintaining parallel tables in multiple files.

### IDE / automation

Workspace notes live under [`.cursor/rules/`](../.cursor/rules/) (e.g. infrastructure inventory, operations discipline). Repo-wide agent entry: **[`AGENTS.md`](../AGENTS.md)**.

---

## By audience

| If you are… | Read first |
|-------------|------------|
| **Operating prod / staging** | [`runbooks.md`](runbooks.md), [`operations-monitoring.md`](operations-monitoring.md), [`infrastructure-inventory.md`](infrastructure-inventory.md), [`deploy/README.md`](../deploy/README.md) |
| **Acting as an ops/debug agent** | [`agent-operations-playbook.md`](agent-operations-playbook.md), [`operations-monitoring.md`](operations-monitoring.md), [`infrastructure-inventory.md`](infrastructure-inventory.md) |
| **Debugging delivery / graders** | [`grading-delivery-semantics.md`](grading-delivery-semantics.md), [`realtime-delivery-contract.md`](realtime-delivery-contract.md) |
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

**Design / rollout examples:** [`plan-recent-connect-rollout.md`](plan-recent-connect-rollout.md), [`architecture-channel-first-realtime.md`](architecture-channel-first-realtime.md), [`remove-channels-last-message-hot-path.md`](remove-channels-last-message-hot-path.md), [`canary-read-receipt-insert-lock-shedding.md`](canary-read-receipt-insert-lock-shedding.md).

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
| [`runbooks.md`](runbooks.md) | Operational — incident response |
| [`agent-operations-playbook.md`](agent-operations-playbook.md) | Operational — agent diagnosis/profiling workflow |
| [`grading-delivery-semantics.md`](grading-delivery-semantics.md) | Operational / course |
| [`realtime-delivery-contract.md`](realtime-delivery-contract.md) | Operational — delivery map |
| [`websocket-generated-client-parity.md`](websocket-generated-client-parity.md) | Operational — client/server parity |
| [`ws-horizontal-scale.md`](ws-horizontal-scale.md) | Playbook / architecture |
| [`db-scaling-messages.md`](db-scaling-messages.md) | Design / scaling notes |
| [`performance-baseline-pack.md`](performance-baseline-pack.md) | Benchmarks |
| [`slos-and-chaos.md`](slos-and-chaos.md) | SLO / chaos |
| [`verification-risk-register.md`](verification-risk-register.md) | Risk register |
| [`plan-recent-connect-rollout.md`](plan-recent-connect-rollout.md) | Rollout history / playbook |
| [`architecture-channel-first-realtime.md`](architecture-channel-first-realtime.md) | Target architecture |
| [`remove-channels-last-message-hot-path.md`](remove-channels-last-message-hot-path.md) | Design proposal |
| [`canary-read-receipt-insert-lock-shedding.md`](canary-read-receipt-insert-lock-shedding.md) | Canary note |

---

## When you change the codebase

1. **New or renamed env var** — Add to [`.env.example`](../.env.example) and describe semantics in [`env.md`](env.md). If prod/staging must pin it, add to [`deploy/env/*.required.env`](../deploy/env/).
2. **New metric** — Export in `backend/src/utils/metrics.ts` (and related); document name/purpose in [`operations-monitoring.md`](operations-monitoring.md) if operators need it.
3. **Behavioral contract (realtime, reads, search)** — Update [`realtime-delivery-contract.md`](realtime-delivery-contract.md) or tests-first; link from [`runbooks.md`](runbooks.md) only if on-call needs it.
4. **Infra (VM, IP, provider)** — Update [`infrastructure-inventory.md`](infrastructure-inventory.md) in the **same** change set.

---

## Optional: copilot / AI context

Prefer **[`AGENTS.md`](../AGENTS.md)** as the stable entry for automation (tables link here). [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) should stay **short** and point to this file + `env.md` + `infrastructure-inventory.md` instead of duplicating env profiles.
