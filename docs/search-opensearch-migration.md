# Search Candidate-Retrieval Migration: Postgres FTS -> Meilisearch -> OpenSearch

Status: operational / migration record  
Owner: backend platform  
Last reviewed: 2026-05-09

This document records the search migration path. The API contract stayed the same while the candidate engine changed from Postgres full-text search, to Meilisearch, to OpenSearch. Postgres remains the final authority for permissions, deleted/edited message state, filters, and response shape.

## Why search moved

### Phase 1: Postgres FTS

The initial search path used Postgres full-text search directly. That was simple and correct because the query ran next to channel membership, deletion state, edit state, author filters, and time filters. Under load, search competed with the same database that served message writes and hot read routes, so search needed a candidate layer that could reduce heavy FTS work on Postgres.

### Phase 2: Meilisearch candidates

Meilisearch was introduced as a candidate-ID retrieval layer. The backend still rechecked candidates in Postgres, so Meili did not become the source of truth. This kept access control and final response formatting unchanged.

The Meili path exposed operational limits:

- Candidate freshness lag could create temporary mismatches between indexed docs and latest message state.
- Indexing and recovery backlogs could affect candidate availability during high write pressure.
- Empty candidates, strict-token mismatches, and recheck errors could trigger expensive fallback paths.
- Dedicated Meili infrastructure needed disk/RAM tuning and operational remediation; see [`history/meili-infra-remediation-2026-05-06.md`](history/meili-infra-remediation-2026-05-06.md).

### Phase 3: OpenSearch candidates

OpenSearch replaced Meilisearch as the production candidate source. The production required env pins:

```env
SEARCH_BACKEND=opensearch
OPENSEARCH_READ_ENABLED=true
OPENSEARCH_DUAL_WRITE_ENABLED=true
```

Staging can still default to Postgres unless OpenSearch is explicitly enabled. Meili is preserved as rollback/legacy infrastructure, but production search reads use OpenSearch candidate retrieval with Postgres recheck.

## Current architecture

1. Search API receives scoped query (`communityId` or `conversationId`).
2. Candidate engine returns candidate message IDs:
   - production: OpenSearch
   - rollback/legacy path: Meilisearch
   - fallback/default-safe path: Postgres search
3. Shared Postgres recheck validates:
   - scope access and channel privacy
   - non-deleted messages
   - latest edited content
   - author/time filters
4. Existing response formatter returns unchanged API payload.

Postgres remains the final authority for permissions, deletions, edits, and response shape.

## Rollout and validation

- Add OpenSearch client/execution modules behind flags.
- Backfill or dual-write to warm the OpenSearch index.
- Compare candidate counts, latency, and final Postgres-rechecked IDs.
- Enable `SEARCH_BACKEND=opensearch` and `OPENSEARCH_READ_ENABLED=true` in a controlled rollout.
- Watch OpenSearch latency, candidate counts, fallback rates, Postgres recheck latency, write/index lag, and route p95/p99.

## Rollback plan

- Disable OpenSearch reads by setting `OPENSEARCH_READ_ENABLED=false`.
- Disable dual-write by setting `OPENSEARCH_DUAL_WRITE_ENABLED=false`.
- Set `SEARCH_BACKEND=meili` to use the preserved Meili candidate path, or `SEARCH_BACKEND=postgres` to use Postgres search directly.
- No schema or response-shape rollback is required because Postgres recheck and API formatting are unchanged.

## Risks

- Candidate ranking differences could change which IDs reach Postgres recheck.
- Single-node OpenSearch settings are not high availability.
- Mapping rigidity (`dynamic: false`) protects shape but can reject unexpected fields.
- Dual-write adds write-path overhead and failure surface; OpenSearch write failures should be fail-open for message sends.
- Query tuning may be required for multilingual terms and exact phrase behavior.
