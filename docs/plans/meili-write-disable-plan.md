# Meilisearch write-disable plan (paper-only)

> **Status:** plan-only — no execution yet. Drafted 2026-05-08.
>
> **Headline:** Meili **synchronous** writes are already off in prod (`MEILI_ENABLED=false` on every worker, fleet-wide; live confirmation below). Reads are 100% on OpenSearch (`SEARCH_BACKEND=opensearch`, `OPENSEARCH_READ_ENABLED=true`; **0** Meili candidate-search ops in the last 6h per `meili_candidate_count_count`). The only remaining Meili-ish footprint is the idle Redis-stream consumer pair (`MEILI_WRITE_STREAM_ENABLED`, `MEILI_WRITE_STREAM_CONSUMER_ENABLED` still `true`), which is harmless because the producer side is gated by `meiliClient.isEnabled()` — but this plan turns those off too so the operator-mental-model matches the wire.

## What is "no reads use Meili" — verified

Direct evidence (live, 2026-05-08):

| Check | Source | Result |
|-------|--------|--------|
| `MEILI_ENABLED` on every prod app/ws VM | `/opt/chatapp/shared/.env` on VM1, VM2, VM3, WSVM1, WSVM2, WSVM3 | **`false`** on all 6 |
| `SEARCH_BACKEND` on every prod app/ws VM | same | **`opensearch`** on all 6 |
| `OPENSEARCH_READ_ENABLED` | same | **`true`** on all 6 |
| Meili search-candidate ops (last 6h) | Prometheus: `sum(increase(meili_candidate_count_count[6h]))` | **0** |
| Meili index ops (last 30m / last 6h) | Prometheus: `sum(increase(meili_index_duration_ms_count[30m]))` | **0** in 30m, ~3.5K in 6h (residual from before the env flip; trending to 0 from the producer-gate) |

Code-level proof:

- `backend/src/messages/routes/postFinish.ts:253` (publish path)
- `backend/src/messages/routes/patch.ts:126` (edit path)
- `backend/src/messages/routes/delete.ts:152` (delete path)

Each is gated by `meiliClient.isEnabled()` (defined in `backend/src/search/meiliClient.ts:188`):

```ts
function isEnabled(): boolean {
  return (
    String(process.env.MEILI_ENABLED || '').toLowerCase() === 'true' &&
    Boolean(MEILI_HOST) &&
    Boolean(MEILI_MASTER_KEY)
  );
}
```

When `MEILI_ENABLED=false`, all three write paths short-circuit before touching Meili **or** the Redis stream that the consumer drains. Reads:

- `backend/src/search/client.ts:843` chooses OpenSearch when `SEARCH_BACKEND === 'opensearch' && OPENSEARCH_READ_ENABLED`.
- `backend/src/search/client.ts:908` would fall back to `meiliClient.isSearchBackend()` only if `SEARCH_BACKEND==='meili' && MEILI_ENABLED===true` — neither holds in prod.

## Exact env flags to **stop Meili indexing** (and what they do)

| Flag | File | Default | Purpose | Action in this plan |
|------|------|---------|---------|---------------------|
| `MEILI_ENABLED` | `deploy/env/prod.required.env` (line 101) | `false` | Master switch on the **producer** side. When false, post/patch/delete routes do not call `meiliClient.indexMessage` / `deleteMessage` and do not push to the Redis stream. | **Already `false` fleet-wide.** Keep. |
| `SEARCH_BACKEND` | line 102 | `opensearch` | Picks the read backend. | Keep `opensearch`. |
| `MEILI_WRITE_STREAM_ENABLED` | line 132 | `true` | Allows the producer to fan out Meili indexing onto a Redis stream **as a secondary path**. Only effective when `MEILI_ENABLED=true`. | Set **`false`** (cosmetic, but reduces operator confusion). |
| `MEILI_WRITE_STREAM_CONSUMER_ENABLED` | line 133 | `true` | Each app worker spins up a Meili stream consumer that polls Redis and writes to Meili. The consumer process always runs while this is `true`, even when no entries arrive. | Set **`false`**. Saves a per-worker poll loop (`XREADGROUP BLOCK 1000ms`) and the periodic `XINFO`/`XPENDING` reaper traffic on Redis. |
| `MEILI_HOST` / `MEILI_MASTER_KEY` | lines 99-100 | required | Connection settings. | **Keep set** — operator might re-enable for rollback. |
| `MEILI_INDEX_MESSAGES` | line 112 | `messages` | Index name. | Keep. |

**Rollback path:** flipping `MEILI_ENABLED=true` plus `MEILI_WRITE_STREAM_*_ENABLED=true` brings indexing back on, **provided** the Meili service and data dir are intact (see "Do-not-delete" below).

## Plan to execute (when approved — not now)

The change is a **3-line env edit + restart** with no migration, no schema change, no data move.

1. Edit `deploy/env/prod.required.env`:

   ```
   - MEILI_WRITE_STREAM_ENABLED=true
   + MEILI_WRITE_STREAM_ENABLED=false

   - MEILI_WRITE_STREAM_CONSUMER_ENABLED=true
   + MEILI_WRITE_STREAM_CONSUMER_ENABLED=false
   ```

   Add a comment block above:

   > Meili is in stop-write mode (writes off via `MEILI_ENABLED=false`).
   > Stream + consumer disabled to stop idle Redis polling. Service stays
   > on the VM for rollback. To re-enable, flip these three plus
   > `MEILI_ENABLED=true` and restart workers.

2. Run a normal deploy (`deploy/deploy-prod-multi.sh`) — no DB migration, no DDL. Phase 1/3/4 restart workers; the producer/consumer immediately stop.

3. Verify:

   | Check | Expected |
   |-------|----------|
   | `redis-cli XLEN meili:messages:write` from any app VM | **stable** (no growth). Today the value is whatever it ended at when `MEILI_ENABLED` flipped to `false`. |
   | `redis-cli XINFO GROUPS meili:messages:write` | `pending` count only decreases (acks of in-flight from the moment of restart) and then stays flat. |
   | `meili_index_duration_ms_count`, `meili_index_failures_total` | flat-lined at the post-deploy value |
   | Worker process list (e.g. `journalctl -u chatapp@4000 --since "10 min ago"`) | no log lines from the Meili stream consumer |
   | Search reads still work | `curl https://$HOST/api/v1/search?q=test` returns OpenSearch-backed results |

4. Backfill / catch-up plan **(intentionally none).** OpenSearch dual-write was already on (`OPENSEARCH_DUAL_WRITE_ENABLED=true`); no Meili catch-up is needed because Meili is no longer the read source.

## Do **not** in this plan

- Do **not** stop or remove the Meilisearch systemd service on `meilisearch-vm` (`10.0.0.146`).
- Do **not** delete `/mnt/meili-nvme/meilisearch-data` or `/mnt/meili-nvme/meilisearch-data-1.8.0`.
- Do **not** remove `MEILI_HOST`, `MEILI_MASTER_KEY`, or `MEILI_INDEX_MESSAGES` from the env profile.
- Do **not** drop UFW rules for `:7700` from the app subnet on `meilisearch-vm`.
- Do **not** change `OPENSEARCH_DUAL_WRITE_ENABLED` or `SEARCH_BACKEND`.

The Meilisearch process keeps running, listening on `10.0.0.146:7700`, with its current index frozen at the moment Meili writes stopped. That's the rollback substrate.

## Rollback rehearsal

Make sure the runbook step is **one variable flip + restart**:

```
sed -i 's/^MEILI_ENABLED=.*/MEILI_ENABLED=true/'                                    deploy/env/prod.required.env
sed -i 's/^MEILI_WRITE_STREAM_ENABLED=.*/MEILI_WRITE_STREAM_ENABLED=true/'          deploy/env/prod.required.env
sed -i 's/^MEILI_WRITE_STREAM_CONSUMER_ENABLED=.*/MEILI_WRITE_STREAM_CONSUMER_ENABLED=true/' deploy/env/prod.required.env
./deploy/deploy-prod-multi.sh <sha>
```

Within ~2 minutes of restart, Meili is receiving sync writes again. Reads stay on OpenSearch unless `SEARCH_BACKEND=meili` is also flipped (don't touch unless rolling all the way back to Meili-as-read).

## Future cleanup tracks (not in this plan)

After 30 days of stable OpenSearch operation:

1. Decommission `meilisearch-vm` Meili service:
   - confirm zero Meili-related env on prod
   - `systemctl stop meilisearch && systemctl disable meilisearch`
   - keep VM up for OpenSearch (which is colocated on the same VM today)
2. Move OpenSearch off the shared VM if/when Meili is fully retired (the host is sized for both — see `docs/infrastructure-inventory.md`).
3. Delete `meili_*` Prometheus metric series (none of the dashboards in `infrastructure/monitoring/grafana-provisioning-remote/dashboards/files/` actively rely on them once Meili is fully retired — verify before removal).
4. Remove `MEILI_*` from `deploy/env/prod.required.env` and code paths in `backend/src/search/meiliClient.ts`, `meiliExecution.ts`, and the gating sites in messages routes.
