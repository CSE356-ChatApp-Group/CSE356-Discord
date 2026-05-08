# OpenSearch Candidate-Retrieval Migration POC

## Why we are considering OpenSearch

We want to validate whether OpenSearch can replace Meilisearch as the candidate-generation layer for message search while keeping the API contract unchanged. The goal is to evaluate query quality, latency, and operational characteristics before any production cutover.

## Current Meili bottleneck summary

- Meili is used only for candidate ID retrieval; Postgres recheck remains required for correctness and access control.
- Candidate freshness lag can create temporary mismatches between indexed docs and latest message state.
- Recovery and indexing backlogs can affect candidate availability during high write pressure.
- We need a second candidate engine to compare relevance and latency before deciding on migration.

## Final target architecture

1. Search API receives scoped query (`communityId` or `conversationId`).
2. Candidate engine (Meili or OpenSearch) returns candidate message IDs only.
3. Shared Postgres recheck validates:
   - scope access and channel privacy
   - non-deleted messages
   - latest edited content
   - author/time filters
4. Existing response formatter returns unchanged API payload.

Postgres remains the final authority for permissions, deletions, edits, and response shape.

## Rollout phases

1. **POC scaffold (this change)**
   - Add OpenSearch client/execution modules behind flags.
   - Keep `SEARCH_BACKEND` default behavior unchanged.
   - Add optional dual-write to warm OpenSearch index.
2. **Shadow indexing**
   - Run backfill script and optional dual-write in non-production.
   - Validate index growth and write error rates.
3. **Read comparison**
   - Run comparison script across known and sampled queries.
   - Compare candidate counts, latency, and final Postgres-rechecked IDs.
4. **Limited staged reads**
   - Enable `SEARCH_BACKEND=opensearch` + `OPENSEARCH_READ_ENABLED=true` only in POC/staging branch environments.
5. **Decision**
   - Keep Meili, iterate OpenSearch tuning, or plan controlled production migration.

## Rollback plan

- Disable OpenSearch reads by setting `OPENSEARCH_READ_ENABLED=false`.
- Disable dual-write by setting `OPENSEARCH_DUAL_WRITE_ENABLED=false`.
- Keep `SEARCH_BACKEND=meili` to retain existing behavior.
- No schema or response-shape rollback is required because Postgres recheck and API formatting are unchanged.

## Risks

- Candidate ranking differences could change which IDs reach Postgres recheck.
- Single-node test settings (`replicas=0`) are not HA and only suitable for local/staging validation.
- Mapping rigidity (`dynamic: false`) protects shape but can reject unexpected fields.
- Dual-write adds write-path overhead and failure surface; this POC keeps failures fail-open.
- Query tuning may be required for multilingual terms and exact phrase behavior.
