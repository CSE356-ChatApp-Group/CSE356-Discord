'use strict';

/**
 * Meilisearch HTTP client – candidate-generation layer for message search.
 *
 * This module is a thin wrapper around Meilisearch's REST API using Node 20
 * native fetch (no extra npm dependency).  All operations are best-effort:
 * errors are logged and never propagated to callers that use the write-path
 * helpers (indexMessage, deleteMessage).  searchMessageCandidates intentionally
 * throws so the search router can catch and fall back to Postgres.
 *
 * Feature flags:
 *   MEILI_ENABLED=true          – enables indexing on message write paths
 *   SEARCH_BACKEND=meili        – enables Meili as the search candidate source
 *
 * Both can be set independently so the index can be kept warm (MEILI_ENABLED)
 * before switching search traffic (SEARCH_BACKEND=meili).
 */

const logger = require('../utils/logger');
const client = require('prom-client');

// ── Configuration ─────────────────────────────────────────────────────────────

const MEILI_HOST = (process.env.MEILI_HOST || '').replace(/\/$/, '');
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || '';
const MEILI_INDEX_MESSAGES = process.env.MEILI_INDEX_MESSAGES || 'messages';
const MEILI_CANDIDATE_LIMIT = Math.max(
  50,
  parseInt(process.env.MEILI_CANDIDATE_LIMIT || '200', 10) || 200,
);
const MEILI_TIMEOUT_MS = Math.min(
  5000,
  Math.max(500, parseInt(process.env.MEILI_TIMEOUT_MS || '2000', 10) || 2000),
);
const MEILI_WRITE_BATCH_SIZE = Math.max(
  1,
  parseInt(process.env.MEILI_WRITE_BATCH_SIZE || '64', 10) || 64,
);
const MEILI_WRITE_FLUSH_MS = Math.max(
  5,
  parseInt(process.env.MEILI_WRITE_FLUSH_MS || '50', 10) || 50,
);

function isEnabled(): boolean {
  return (
    String(process.env.MEILI_ENABLED || '').toLowerCase() === 'true' &&
    Boolean(MEILI_HOST) &&
    Boolean(MEILI_MASTER_KEY)
  );
}

function isSearchBackend(): boolean {
  return (
    String(process.env.SEARCH_BACKEND || '').toLowerCase() === 'meili' &&
    isEnabled()
  );
}

// ── Prometheus metrics ────────────────────────────────────────────────────────

const meiliIndexDurationMs = new client.Histogram({
  name: 'meili_index_duration_ms',
  help: 'Time taken to index/delete a message in Meilisearch (ms)',
  labelNames: ['op'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
});

const meiliSearchDurationMs = new client.Histogram({
  name: 'meili_search_duration_ms',
  help: 'Time taken to query Meilisearch for candidates (ms)',
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2000],
});

const meiliIndexFailuresTotal = new client.Counter({
  name: 'meili_index_failures_total',
  help: 'Meilisearch indexing errors (write-path, best-effort)',
  labelNames: ['op'],
});

const meiliSearchFallbackTotal = new client.Counter({
  name: 'meili_search_fallback_total',
  help: 'Searches that fell back to Postgres because Meilisearch failed or timed out',
});

const meiliCandidateCount = new client.Histogram({
  name: 'meili_candidate_count',
  help: 'Number of candidate IDs returned by Meilisearch before Postgres recheck',
  buckets: [0, 5, 10, 25, 50, 100, 200, 500],
});

// ── In-process write batching ────────────────────────────────────────────────

const pendingUpserts = new Map<string, MeiliMessageDoc>();
let writeFlushTimer: NodeJS.Timeout | null = null;
let writeFlushInFlight = false;
let writeFlushQueued = false;

function pendingWriteCount(): number {
  return pendingUpserts.size;
}

function clearWriteFlushTimer() {
  if (!writeFlushTimer) return;
  clearTimeout(writeFlushTimer);
  writeFlushTimer = null;
}

function takePendingUpserts(max: number): MeiliMessageDoc[] {
  const docs: MeiliMessageDoc[] = [];
  for (const [id, doc] of pendingUpserts) {
    pendingUpserts.delete(id);
    docs.push(doc);
    if (docs.length >= max) break;
  }
  return docs;
}

function scheduleWriteFlush(immediate = false) {
  if (immediate || pendingWriteCount() >= MEILI_WRITE_BATCH_SIZE) {
    clearWriteFlushTimer();
    setImmediate(() => {
      void flushPendingWrites();
    });
    return;
  }

  if (writeFlushTimer) return;
  writeFlushTimer = setTimeout(() => {
    writeFlushTimer = null;
    void flushPendingWrites();
  }, MEILI_WRITE_FLUSH_MS);
  if (typeof writeFlushTimer.unref === 'function') writeFlushTimer.unref();
}

async function flushPendingWrites(): Promise<void> {
  clearWriteFlushTimer();
  if (writeFlushInFlight) {
    writeFlushQueued = true;
    return;
  }

  writeFlushInFlight = true;
  try {
    while (pendingWriteCount() > 0) {
      writeFlushQueued = false;
      const docs = takePendingUpserts(MEILI_WRITE_BATCH_SIZE);
      if (!docs.length) break;

      const t0 = Date.now();
      try {
        await batchIndexMessages(docs);
        meiliIndexDurationMs.observe({ op: 'index' }, Date.now() - t0);
      } catch (err: any) {
        meiliIndexFailuresTotal.inc({ op: 'index' }, docs.length);
        logger.warn(
          {
            err: { message: err?.message },
            messageIds: docs.slice(0, 5).map((doc) => doc.id),
            batchSize: docs.length,
          },
          'meili: batch indexMessage flush failed',
        );
      }

      if (!writeFlushQueued && pendingWriteCount() === 0) break;
    }
  } finally {
    writeFlushInFlight = false;
    if (pendingWriteCount() > 0) scheduleWriteFlush(true);
  }
}

// ── Internal HTTP helper ──────────────────────────────────────────────────────

async function meiliFetch(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  const controller = new AbortController();
  const tid = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? MEILI_TIMEOUT_MS,
  );
  try {
    const res = await fetch(`${MEILI_HOST}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MEILI_MASTER_KEY}`,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Meili ${options.method ?? 'GET'} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  } finally {
    clearTimeout(tid);
  }
}

// ── Document type ─────────────────────────────────────────────────────────────

export interface MeiliMessageDoc {
  id: string;
  content: string;
  authorId: string;
  channelId: string | null;
  communityId: string | null;
  conversationId: string | null;
  /** Unix ms – used for sort and range filters. */
  createdAt: number;
  updatedAt: number | null;
}

function toDoc(msg: MeiliMessageDoc): MeiliMessageDoc {
  return {
    id: String(msg.id),
    content: String(msg.content || ''),
    authorId: String(msg.authorId),
    channelId: msg.channelId ? String(msg.channelId) : null,
    communityId: msg.communityId ? String(msg.communityId) : null,
    conversationId: msg.conversationId ? String(msg.conversationId) : null,
    createdAt: Number(msg.createdAt),
    updatedAt: msg.updatedAt != null ? Number(msg.updatedAt) : null,
  };
}

// ── Index management ──────────────────────────────────────────────────────────

async function setupIndex(): Promise<void> {
  // Create index (idempotent)
  try {
    await meiliFetch(`/indexes`, {
      method: 'POST',
      body: { uid: MEILI_INDEX_MESSAGES, primaryKey: 'id' },
      timeoutMs: 5000,
    });
  } catch (err: any) {
    // 409 = index already exists, that is fine
    if (!String(err?.message || '').includes('409')) {
      throw err;
    }
  }

  // Configure searchable attributes
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/settings/searchable-attributes`, {
    method: 'PUT',
    body: ['content'],
    timeoutMs: 5000,
  });

  // Configure filterable attributes
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/settings/filterable-attributes`, {
    method: 'PUT',
    body: ['authorId', 'channelId', 'communityId', 'conversationId', 'createdAt'],
    timeoutMs: 5000,
  });

  // Configure sortable attributes
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/settings/sortable-attributes`, {
    method: 'PUT',
    body: ['createdAt'],
    timeoutMs: 5000,
  });

  // Stricter typo behavior than Meili defaults — still a candidate generator; the
  // app applies strict token AND on Postgres-rechecked rows before returning.
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/settings/typo-tolerance`, {
    method: 'PATCH',
    body: {
      enabled: true,
      minWordSizeForTypos: { oneTypo: 6, twoTypos: 12 },
    },
    timeoutMs: 5000,
  });
}

// ── Health ────────────────────────────────────────────────────────────────────

async function checkHealth(): Promise<{ ok: boolean; status: string }> {
  try {
    const data = await meiliFetch('/health', { timeoutMs: 3000 });
    const ok = data?.status === 'available';
    return { ok, status: data?.status ?? 'unknown' };
  } catch (err: any) {
    return { ok: false, status: String(err?.message || 'unreachable').slice(0, 120) };
  }
}

async function checkIndex(): Promise<{ ok: boolean; uid?: string; error?: string }> {
  try {
    const data = await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}`, { timeoutMs: 3000 });
    return { ok: Boolean(data?.uid), uid: data?.uid };
  } catch (err: any) {
    return { ok: false, error: String(err?.message || '').slice(0, 120) };
  }
}

// ── Write path helpers ────────────────────────────────────────────────────────

async function indexMessage(msg: MeiliMessageDoc): Promise<void> {
  if (!isEnabled()) return;
  pendingUpserts.set(String(msg.id), toDoc(msg));
  scheduleWriteFlush();
}

async function deleteMessage(id: string): Promise<void> {
  if (!isEnabled()) return;
  pendingUpserts.delete(String(id));
  const t0 = Date.now();
  try {
    await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/documents/${id}`, {
      method: 'DELETE',
    });
    meiliIndexDurationMs.observe({ op: 'delete' }, Date.now() - t0);
  } catch (err: any) {
    meiliIndexFailuresTotal.inc({ op: 'delete' });
    logger.warn({ err: { message: err?.message }, messageId: id }, 'meili: deleteMessage failed');
  }
}

async function batchIndexMessages(msgs: MeiliMessageDoc[]): Promise<void> {
  if (!msgs.length) return;
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/documents`, {
    method: 'POST',
    body: msgs.map(toDoc),
    timeoutMs: Math.max(MEILI_TIMEOUT_MS, 10_000),
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

interface SearchCandidateOpts {
  communityId?: string;
  conversationId?: string;
  authorId?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

/**
 * Query Meilisearch for candidate message IDs.
 * Callers MUST recheck every ID in Postgres before returning to the client.
 * Throws on error so the caller can fall back to Postgres search.
 */
async function searchMessageCandidates(
  q: string,
  opts: SearchCandidateOpts = {},
): Promise<{ ids: string[]; estimatedTotal: number }> {
  const t0 = Date.now();

  const userOffset = Number(opts.offset) || 0;
  const userLimit  = Number(opts.limit)  || 20;
  // Request enough candidates to cover the requested page plus a buffer.
  const candidateLimit = Math.max(MEILI_CANDIDATE_LIMIT, userOffset + userLimit);

  const filters: string[] = [];
  if (opts.communityId) {
    filters.push(`communityId = "${opts.communityId}"`);
  } else if (opts.conversationId) {
    filters.push(`conversationId = "${opts.conversationId}"`);
  }
  if (opts.authorId) {
    filters.push(`authorId = "${opts.authorId}"`);
  }
  if (opts.after) {
    const ms = new Date(opts.after).getTime();
    if (!isNaN(ms)) filters.push(`createdAt >= ${ms}`);
  }
  if (opts.before) {
    const ms = new Date(opts.before).getTime();
    if (!isNaN(ms)) filters.push(`createdAt <= ${ms}`);
  }

  const body: Record<string, unknown> = {
    q: q || '',
    sort: ['createdAt:desc'],
    limit: candidateLimit,
    offset: 0,
    attributesToRetrieve: ['id'],
  };
  if (filters.length) {
    body.filter = filters.join(' AND ');
  }

  const data = await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/search`, {
    method: 'POST',
    body,
  });

  const ms = Date.now() - t0;
  meiliSearchDurationMs.observe(ms);

  const hits: string[] = (data?.hits ?? []).map((h: any) => String(h.id));
  meiliCandidateCount.observe(hits.length);

  logger.debug(
    {
      meili_search_ms: ms,
      candidate_count: hits.length,
      estimated_total: data?.estimatedTotalHits ?? 0,
      scope: opts.communityId ? 'community' : 'conversation',
    },
    'meili_search',
  );

  return { ids: hits, estimatedTotal: data?.estimatedTotalHits ?? 0 };
}

function incFallbackTotal() {
  meiliSearchFallbackTotal.inc();
}

module.exports = {
  isEnabled,
  isSearchBackend,
  setupIndex,
  checkHealth,
  checkIndex,
  indexMessage,
  deleteMessage,
  batchIndexMessages,
  searchMessageCandidates,
  incFallbackTotal,
  MEILI_INDEX_MESSAGES,
};
