
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
const { redisSearch } = require('../db/redis');
const http = require('http');
const https = require('https');
const {
  ENGLISH_STOP_WORDS,
  stripEnglishStopWords,
} = require('./stopWords');

// ── Configuration ─────────────────────────────────────────────────────────────

const MEILI_HOST = (process.env.MEILI_HOST || '').replace(/\/$/, '');
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || '';
const MEILI_INDEX_MESSAGES = process.env.MEILI_INDEX_MESSAGES || 'messages';
const MEILI_CANDIDATE_LIMIT = Math.max(
  50,
  parseInt(process.env.MEILI_CANDIDATE_LIMIT || '200', 10) || 200,
);
const MEILI_CANDIDATE_MIN_LIMIT = Math.max(
  50,
  Math.min(
    MEILI_CANDIDATE_LIMIT,
    parseInt(process.env.MEILI_CANDIDATE_MIN_LIMIT || '100', 10) || 100,
  ),
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
const MEILI_WRITE_STREAM_ENABLED =
  String(process.env.MEILI_WRITE_STREAM_ENABLED || '').toLowerCase() === 'true'
  || process.env.MEILI_WRITE_STREAM_ENABLED === '1';
const MEILI_WRITE_STREAM_CONSUMER_ENABLED =
  String(process.env.MEILI_WRITE_STREAM_CONSUMER_ENABLED || '').toLowerCase() === 'true'
  || process.env.MEILI_WRITE_STREAM_CONSUMER_ENABLED === '1';
const MEILI_WRITE_STREAM_KEY = process.env.MEILI_WRITE_STREAM_KEY || 'meili:messages:write';
const MEILI_WRITE_STREAM_GROUP = process.env.MEILI_WRITE_STREAM_GROUP || 'meili-indexers';
const MEILI_WRITE_STREAM_MAXLEN = Math.max(
  1000,
  parseInt(process.env.MEILI_WRITE_STREAM_MAXLEN || '100000', 10) || 100000,
);
const MEILI_WRITE_STREAM_CONSUMER_SLOTS = Math.max(
  1,
  Math.min(16, parseInt(process.env.MEILI_WRITE_STREAM_CONSUMER_SLOTS || '1', 10) || 1),
);
const MEILI_WRITE_STREAM_READ_COUNT = Math.max(
  1,
  Math.min(1000, parseInt(process.env.MEILI_WRITE_STREAM_READ_COUNT || String(MEILI_WRITE_BATCH_SIZE), 10) || MEILI_WRITE_BATCH_SIZE),
);
const MEILI_WRITE_STREAM_BLOCK_MS = Math.max(
  100,
  Math.min(5000, parseInt(process.env.MEILI_WRITE_STREAM_BLOCK_MS || '1000', 10) || 1000),
);
const MEILI_WRITE_STREAM_COALESCE_MS = Math.max(
  0,
  Math.min(
    60000,
    parseInt(process.env.MEILI_WRITE_STREAM_COALESCE_MS || String(MEILI_WRITE_FLUSH_MS), 10) || MEILI_WRITE_FLUSH_MS,
  ),
);
const MEILI_WRITE_STREAM_COALESCE_BLOCK_MS = Math.max(
  10,
  Math.min(1000, parseInt(process.env.MEILI_WRITE_STREAM_COALESCE_BLOCK_MS || '100', 10) || 100),
);
const MEILI_WRITE_STREAM_LOCK_TTL_MS = Math.max(
  5000,
  Math.min(60000, parseInt(process.env.MEILI_WRITE_STREAM_LOCK_TTL_MS || '15000', 10) || 15000),
);
const MEILI_WRITE_STREAM_CLAIM_IDLE_MS = Math.max(
  10000,
  Math.min(600000, parseInt(process.env.MEILI_WRITE_STREAM_CLAIM_IDLE_MS || '60000', 10) || 60000),
);
const MEILI_HTTP_KEEPALIVE_ENABLED =
  String(process.env.MEILI_HTTP_KEEPALIVE_ENABLED || 'true').toLowerCase() !== 'false'
  && process.env.MEILI_HTTP_KEEPALIVE_ENABLED !== '0';
const MEILI_HTTP_KEEPALIVE_MAX_SOCKETS = Math.max(
  1,
  Math.min(256, parseInt(process.env.MEILI_HTTP_KEEPALIVE_MAX_SOCKETS || '64', 10) || 64),
);
const MEILI_HTTP_KEEPALIVE_MAX_FREE_SOCKETS = Math.max(
  1,
  Math.min(
    MEILI_HTTP_KEEPALIVE_MAX_SOCKETS,
    parseInt(process.env.MEILI_HTTP_KEEPALIVE_MAX_FREE_SOCKETS || '16', 10) || 16,
  ),
);
const MEILI_HTTP_KEEPALIVE_MS = Math.max(
  1000,
  Math.min(300000, parseInt(process.env.MEILI_HTTP_KEEPALIVE_MS || '60000', 10) || 60000),
);
// Optional async polling of Meili task UIDs to surface task wait/duration metrics.
// Polling is fire-and-forget against /tasks/<uid>; bounded backoff and timeout
// keep the load on Meili low.
const MEILI_TASK_METRICS_ENABLED =
  String(process.env.MEILI_TASK_METRICS_ENABLED || 'true').toLowerCase() !== 'false'
  && process.env.MEILI_TASK_METRICS_ENABLED !== '0';
const MEILI_TASK_METRICS_POLL_MIN_MS = Math.max(
  50,
  Math.min(5000, parseInt(process.env.MEILI_TASK_METRICS_POLL_MIN_MS || '250', 10) || 250),
);
const MEILI_TASK_METRICS_POLL_MAX_MS = Math.max(
  MEILI_TASK_METRICS_POLL_MIN_MS,
  Math.min(30000, parseInt(process.env.MEILI_TASK_METRICS_POLL_MAX_MS || '5000', 10) || 5000),
);
const MEILI_TASK_METRICS_TIMEOUT_MS = Math.max(
  5000,
  Math.min(900000, parseInt(process.env.MEILI_TASK_METRICS_TIMEOUT_MS || '300000', 10) || 300000),
);
// Cap chunk size sent in a single Meili documents POST when draining the
// stream consumer. Falls back to MEILI_WRITE_BATCH_SIZE so a single env knob
// (`MEILI_WRITE_BATCH_SIZE`) bounds the docs-per-Meili-task on every write
// path. Set higher than BATCH_SIZE only if you intentionally want stream
// batches larger than the in-process flush size.
const MEILI_WRITE_STREAM_TASK_CHUNK = Math.max(
  1,
  Math.min(
    10000,
    parseInt(process.env.MEILI_WRITE_STREAM_TASK_CHUNK || String(MEILI_WRITE_BATCH_SIZE), 10)
      || MEILI_WRITE_BATCH_SIZE,
  ),
);
const MEILI_WRITE_QUEUE_DEPTH_INTERVAL_MS = Math.max(
  500,
  Math.min(60000, parseInt(process.env.MEILI_WRITE_QUEUE_DEPTH_INTERVAL_MS || '5000', 10) || 5000),
);

const meiliHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: MEILI_HTTP_KEEPALIVE_MS,
  maxSockets: MEILI_HTTP_KEEPALIVE_MAX_SOCKETS,
  maxFreeSockets: MEILI_HTTP_KEEPALIVE_MAX_FREE_SOCKETS,
});
const meiliHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: MEILI_HTTP_KEEPALIVE_MS,
  maxSockets: MEILI_HTTP_KEEPALIVE_MAX_SOCKETS,
  maxFreeSockets: MEILI_HTTP_KEEPALIVE_MAX_FREE_SOCKETS,
});

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
  help: 'Searches that fell back to Postgres from the Meilisearch candidate path',
  labelNames: ['reason'],
});

const meiliCandidateCount = new client.Histogram({
  name: 'meili_candidate_count',
  help: 'Number of candidate IDs returned by Meilisearch before Postgres recheck',
  buckets: [0, 5, 10, 25, 50, 100, 200, 500],
});

const meiliWriteStreamEnqueuedTotal = new client.Counter({
  name: 'meili_write_stream_enqueued_total',
  help: 'Meilisearch write operations enqueued to Redis Stream',
  labelNames: ['op', 'result'],
});

const meiliWriteStreamConsumedTotal = new client.Counter({
  name: 'meili_write_stream_consumed_total',
  help: 'Meilisearch write stream operations consumed',
  labelNames: ['op', 'result'],
});

const meiliWriteStreamBatchSize = new client.Histogram({
  name: 'meili_write_stream_batch_size',
  help: 'Number of Redis Stream entries handled per Meili write consumer batch',
  buckets: [1, 5, 10, 25, 50, 100, 200, 500, 1000],
});

// New visibility-lag metrics. Distinct from the existing
// `meili_write_stream_batch_size` (entries per consumer ack cycle): this one
// reports the number of documents in each individual Meili task POST after
// chunking (chunk size capped by MEILI_WRITE_STREAM_TASK_CHUNK /
// MEILI_WRITE_BATCH_SIZE).
const meiliWriteBatchSize = new client.Histogram({
  name: 'meili_write_batch_size',
  help: 'Number of documents per single Meili documents POST (after chunking)',
  labelNames: ['op'],
  buckets: [1, 5, 10, 25, 50, 100, 200, 500, 1000],
});

const meiliWriteFlushDurationMs = new client.Histogram({
  name: 'meili_write_flush_duration_ms',
  help: 'Wall time for a single Meili documents POST (chunk flush, ms)',
  labelNames: ['op'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
});

const meiliWriteEnqueueToFlushLagMs = new client.Histogram({
  name: 'meili_write_enqueue_to_flush_lag_ms',
  help: 'Time from enqueue (Redis stream) to flush (Meili POST) per document, ms',
  labelNames: ['op'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000],
});

const meiliWriteQueueDepth = new client.Gauge({
  name: 'meili_write_queue_depth',
  help: 'Approximate length of the Redis Stream backing Meili writes (XLEN)',
});

const meiliTaskWaitMs = new client.Histogram({
  name: 'meili_task_wait_ms',
  help: 'Meili task queue wait time (enqueuedAt → startedAt), ms',
  labelNames: ['type', 'status'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000],
});

const meiliTaskDurationMs = new client.Histogram({
  name: 'meili_task_duration_ms',
  help: 'Meili task processing duration (startedAt → finishedAt), ms',
  labelNames: ['type', 'status'],
  buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000, 300000],
});

// ── In-process write batching ────────────────────────────────────────────────

interface PendingUpsertEntry {
  doc: MeiliMessageDoc;
  enqueuedAtMs: number;
}
const pendingUpserts = new Map<string, PendingUpsertEntry>();
let writeFlushTimer: NodeJS.Timeout | null = null;
let writeFlushInFlight = false;
let writeFlushQueued = false;
let streamConsumerClients: any[] = [];
let streamConsumerStopping = false;
let streamConsumerStarted = false;
let queueDepthTimer: NodeJS.Timeout | null = null;

function pendingWriteCount(): number {
  return pendingUpserts.size;
}

function clearWriteFlushTimer() {
  if (!writeFlushTimer) return;
  clearTimeout(writeFlushTimer);
  writeFlushTimer = null;
}

function takePendingUpserts(max: number): PendingUpsertEntry[] {
  const entries: PendingUpsertEntry[] = [];
  for (const [id, entry] of pendingUpserts) {
    pendingUpserts.delete(id);
    entries.push(entry);
    if (entries.length >= max) break;
  }
  return entries;
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
      const entries = takePendingUpserts(MEILI_WRITE_BATCH_SIZE);
      if (!entries.length) break;

      const docs = entries.map((entry) => entry.doc);
      const t0 = Date.now();
      try {
        const result = await batchIndexMessages(docs);
        const flushMs = Date.now() - t0;
        meiliIndexDurationMs.observe({ op: 'index' }, flushMs);
        meiliWriteBatchSize.observe({ op: 'upsert' }, docs.length);
        meiliWriteFlushDurationMs.observe({ op: 'index' }, flushMs);
        observeEnqueueLagFromEntries(entries, t0, 'upsert');
        if (result?.taskUid != null) schedulePollMeiliTaskMetrics(result.taskUid, 'index');
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

function observeEnqueueLagFromEntries(
  entries: Array<{ enqueuedAtMs: number }>,
  flushedAtMs: number,
  op: 'upsert' | 'delete',
): void {
  for (const entry of entries) {
    const enqueuedAt = Number(entry.enqueuedAtMs);
    if (!Number.isFinite(enqueuedAt) || enqueuedAt <= 0) continue;
    const lag = Math.max(0, flushedAtMs - enqueuedAt);
    meiliWriteEnqueueToFlushLagMs.observe({ op }, lag);
  }
}

/** Parse the Redis Stream entry id (`<ms>-<seq>`) to extract enqueue time. */
function parseStreamEntryEnqueueMs(entryId: string): number {
  const dash = entryId.indexOf('-');
  const tsStr = dash === -1 ? entryId : entryId.slice(0, dash);
  const ms = parseInt(tsStr, 10);
  return Number.isFinite(ms) ? ms : 0;
}

function streamConsumerName(slot: number) {
  return `meili-${process.env.HOSTNAME || 'host'}-${process.env.PORT || '0'}-${process.pid}-${slot}`;
}

function streamLockKey(slot: number) {
  return `${MEILI_WRITE_STREAM_KEY}:consumer_lock:${slot}`;
}

function parseStreamFields(fields: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    out[String(fields[i])] = String(fields[i + 1]);
  }
  return out;
}

async function enqueueMeiliWriteStream(op: 'upsert' | 'delete', payload: Record<string, unknown>) {
  // Stamp the producer-side enqueue time so consumers can compute the
  // enqueue→flush lag even when this writer's clock differs from the Redis
  // server (within the bounds of NTP drift). Consumers fall back to the
  // Redis stream entry id timestamp when this field is absent.
  const stamped = { ...payload, enqueuedAtMs: Date.now() };
  await redisSearch.xadd(
    MEILI_WRITE_STREAM_KEY,
    'MAXLEN',
    '~',
    String(MEILI_WRITE_STREAM_MAXLEN),
    '*',
    'op',
    op,
    'payload',
    JSON.stringify(stamped),
  );
  meiliWriteStreamEnqueuedTotal.inc({ op, result: 'ok' });
}

async function ensureMeiliWriteStreamGroup(clientForStream: any) {
  try {
    await clientForStream.xgroup(
      'CREATE',
      MEILI_WRITE_STREAM_KEY,
      MEILI_WRITE_STREAM_GROUP,
      '0',
      'MKSTREAM',
    );
  } catch (err: any) {
    if (!String(err?.message || '').includes('BUSYGROUP')) throw err;
  }
}

async function processMeiliWriteStreamMessages(
  clientForStream: any,
  entries: Array<[string, string[]]>,
) {
  if (!entries.length) return;

  // Track the *latest* op per message id (last write wins) along with the
  // earliest enqueue time we have seen for it, so the enqueue→flush lag
  // metric reflects the oldest pending mutation rather than the coalesced
  // tail.
  interface CoalescedEntry {
    op: 'upsert' | 'delete';
    doc?: MeiliMessageDoc;
    enqueuedAtMs: number;
  }
  const latestByMessageId = new Map<string, CoalescedEntry>();
  const ackIds: string[] = [];

  for (const [entryId, fields] of entries) {
    const parsed = parseStreamFields(fields);
    const op = parsed.op === 'delete' ? 'delete' : parsed.op === 'upsert' ? 'upsert' : null;
    if (!op) {
      ackIds.push(entryId);
      meiliWriteStreamConsumedTotal.inc({ op: 'unknown', result: 'invalid' });
      continue;
    }
    let payload: any = null;
    try {
      payload = JSON.parse(parsed.payload || '{}');
    } catch {
      ackIds.push(entryId);
      meiliWriteStreamConsumedTotal.inc({ op, result: 'invalid' });
      continue;
    }

    const messageId = String(payload.id || '');
    if (!messageId) {
      ackIds.push(entryId);
      meiliWriteStreamConsumedTotal.inc({ op, result: 'invalid' });
      continue;
    }
    // Prefer the explicit enqueuedAtMs producer field if present; fall back
    // to the Redis stream entry id timestamp for older entries.
    const payloadEnqueuedAt = Number(payload.enqueuedAtMs);
    const entryEnqueuedAt = Number.isFinite(payloadEnqueuedAt) && payloadEnqueuedAt > 0
      ? payloadEnqueuedAt
      : parseStreamEntryEnqueueMs(entryId);
    const previous = latestByMessageId.get(messageId);
    const earliestEnqueuedAt = previous && previous.enqueuedAtMs > 0
      ? Math.min(previous.enqueuedAtMs, entryEnqueuedAt || previous.enqueuedAtMs)
      : entryEnqueuedAt;
    if (op === 'delete') {
      latestByMessageId.set(messageId, { op, enqueuedAtMs: earliestEnqueuedAt });
    } else {
      latestByMessageId.set(messageId, { op, doc: toDoc(payload), enqueuedAtMs: earliestEnqueuedAt });
    }
    ackIds.push(entryId);
  }

  const upserts: Array<{ doc: MeiliMessageDoc; enqueuedAtMs: number }> = [];
  const deletes: Array<{ id: string; enqueuedAtMs: number }> = [];
  for (const [id, item] of latestByMessageId) {
    if (item.op === 'delete') {
      deletes.push({ id, enqueuedAtMs: item.enqueuedAtMs });
    } else if (item.doc) {
      upserts.push({ doc: item.doc, enqueuedAtMs: item.enqueuedAtMs });
    }
  }

  // Chunk the coalesced batches so each Meili task is bounded by
  // MEILI_WRITE_STREAM_TASK_CHUNK (defaults to MEILI_WRITE_BATCH_SIZE).
  // Without this the stream consumer would happily POST 1000-doc tasks even
  // when MEILI_WRITE_BATCH_SIZE was set to 200, defeating the point of the
  // tunable.
  // If any chunk fails we re-throw so the surrounding consumer slot skips
  // the XACK below; XAUTOCLAIM will redeliver the unacked entries on the
  // next tick. This preserves the existing at-least-once retry semantics
  // even with per-chunk failure isolation for metrics.
  for (let i = 0; i < upserts.length; i += MEILI_WRITE_STREAM_TASK_CHUNK) {
    const chunkEntries = upserts.slice(i, i + MEILI_WRITE_STREAM_TASK_CHUNK);
    const docs = chunkEntries.map((entry) => entry.doc);
    const t0 = Date.now();
    let result: { taskUid?: number } | null = null;
    try {
      result = await batchIndexMessages(docs);
    } catch (err: any) {
      meiliIndexFailuresTotal.inc({ op: 'index_stream' }, docs.length);
      logger.warn(
        {
          err: { message: err?.message },
          messageIds: docs.slice(0, 5).map((doc) => doc.id),
          batchSize: docs.length,
        },
        'meili: stream upsert chunk failed',
      );
      throw err;
    }
    const flushMs = Date.now() - t0;
    meiliIndexDurationMs.observe({ op: 'index_stream' }, flushMs);
    meiliWriteBatchSize.observe({ op: 'upsert' }, docs.length);
    meiliWriteFlushDurationMs.observe({ op: 'index_stream' }, flushMs);
    observeEnqueueLagFromEntries(chunkEntries, t0, 'upsert');
    meiliWriteStreamConsumedTotal.inc({ op: 'upsert', result: 'ok' }, docs.length);
    if (result?.taskUid != null) schedulePollMeiliTaskMetrics(result.taskUid, 'index_stream');
  }

  for (let i = 0; i < deletes.length; i += MEILI_WRITE_STREAM_TASK_CHUNK) {
    const chunkEntries = deletes.slice(i, i + MEILI_WRITE_STREAM_TASK_CHUNK);
    const ids = chunkEntries.map((entry) => entry.id);
    const t0 = Date.now();
    const result = await batchDeleteMessages(ids, 'delete_stream');
    const flushMs = Date.now() - t0;
    meiliIndexDurationMs.observe({ op: 'delete_stream' }, flushMs);
    meiliWriteBatchSize.observe({ op: 'delete' }, ids.length);
    meiliWriteFlushDurationMs.observe({ op: 'delete_stream' }, flushMs);
    observeEnqueueLagFromEntries(chunkEntries, t0, 'delete');
    meiliWriteStreamConsumedTotal.inc({ op: 'delete', result: 'ok' }, ids.length);
    if (result?.taskUid != null) schedulePollMeiliTaskMetrics(result.taskUid, 'delete_stream');
  }

  if (ackIds.length) {
    await clientForStream.xack(MEILI_WRITE_STREAM_KEY, MEILI_WRITE_STREAM_GROUP, ...ackIds);
    meiliWriteStreamBatchSize.observe(ackIds.length);
  }
}

async function readMeiliWriteStreamBatch(clientForStream: any, consumerName: string) {
  try {
    const claimed = await clientForStream.xautoclaim(
      MEILI_WRITE_STREAM_KEY,
      MEILI_WRITE_STREAM_GROUP,
      consumerName,
      MEILI_WRITE_STREAM_CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      String(MEILI_WRITE_STREAM_READ_COUNT),
    );
    const claimedMessages = Array.isArray(claimed?.[1]) ? claimed[1] : [];
    if (claimedMessages.length) {
      await processMeiliWriteStreamMessages(clientForStream, claimedMessages);
      return;
    }
  } catch (err: any) {
    if (!String(err?.message || '').includes('unknown command')) {
      logger.warn(
        { err: { message: err?.message } },
        'meili: write stream pending reclaim failed',
      );
    }
  }

  const res = await clientForStream.xreadgroup(
    'GROUP',
    MEILI_WRITE_STREAM_GROUP,
    consumerName,
    'COUNT',
    String(MEILI_WRITE_STREAM_READ_COUNT),
    'BLOCK',
    String(MEILI_WRITE_STREAM_BLOCK_MS),
    'STREAMS',
    MEILI_WRITE_STREAM_KEY,
    '>',
  );
  if (!Array.isArray(res) || !res.length) return;
  const first = res[0];
  const messages = Array.isArray(first?.[1]) ? first[1] : [];
  if (!messages.length) return;
  await processMeiliWriteStreamMessages(
    clientForStream,
    await coalesceMeiliWriteStreamMessages(clientForStream, consumerName, messages),
  );
}

async function readNewMeiliWriteStreamMessages(
  clientForStream: any,
  consumerName: string,
  count: number,
  blockMs: number,
): Promise<Array<[string, string[]]>> {
  const res = await clientForStream.xreadgroup(
    'GROUP',
    MEILI_WRITE_STREAM_GROUP,
    consumerName,
    'COUNT',
    String(count),
    'BLOCK',
    String(blockMs),
    'STREAMS',
    MEILI_WRITE_STREAM_KEY,
    '>',
  );
  if (!Array.isArray(res) || !res.length) return [];
  const first = res[0];
  const messages = Array.isArray(first?.[1]) ? first[1] : [];
  return messages;
}

async function coalesceMeiliWriteStreamMessages(
  clientForStream: any,
  consumerName: string,
  initialMessages: Array<[string, string[]]>,
): Promise<Array<[string, string[]]>> {
  if (
    MEILI_WRITE_STREAM_COALESCE_MS <= 0 ||
    initialMessages.length >= MEILI_WRITE_STREAM_READ_COUNT ||
    streamConsumerStopping
  ) {
    return initialMessages;
  }

  const messages = initialMessages.slice();
  const deadline = Date.now() + MEILI_WRITE_STREAM_COALESCE_MS;

  while (messages.length < MEILI_WRITE_STREAM_READ_COUNT && !streamConsumerStopping) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    const next = await readNewMeiliWriteStreamMessages(
      clientForStream,
      consumerName,
      MEILI_WRITE_STREAM_READ_COUNT - messages.length,
      Math.min(MEILI_WRITE_STREAM_COALESCE_BLOCK_MS, remainingMs),
    );
    if (next.length) {
      messages.push(...next);
    }
  }

  return messages;
}

async function runMeiliWriteStreamConsumerSlot(clientForStream: any, slot: number) {
  const consumerName = streamConsumerName(slot);
  const lockKey = streamLockKey(slot);
  const lockValue = consumerName;

  while (!streamConsumerStopping) {
    try {
      const acquired = await redisSearch.set(lockKey, lockValue, 'PX', MEILI_WRITE_STREAM_LOCK_TTL_MS, 'NX');
      if (!acquired) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000, MEILI_WRITE_STREAM_LOCK_TTL_MS / 3)));
        continue;
      }

      try {
        while (!streamConsumerStopping) {
          const current = await redisSearch.get(lockKey).catch(() => null);
          if (current !== lockValue) break;
          await redisSearch.pexpire(lockKey, MEILI_WRITE_STREAM_LOCK_TTL_MS);
          await readMeiliWriteStreamBatch(clientForStream, consumerName);
        }
      } finally {
        const current = await redisSearch.get(lockKey).catch(() => null);
        if (current === lockValue) await redisSearch.del(lockKey).catch(() => {});
      }
    } catch (err: any) {
      if (!streamConsumerStopping) {
        logger.warn(
          { err: { message: err?.message }, slot },
          'meili: write stream consumer tick failed',
        );
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }
}

function startMeiliWriteStreamConsumerIfEnabled() {
  if (!isEnabled() || !MEILI_WRITE_STREAM_ENABLED || !MEILI_WRITE_STREAM_CONSUMER_ENABLED) return;
  if (streamConsumerStarted) return;
  streamConsumerStarted = true;
  streamConsumerStopping = false;

  streamConsumerClients = Array.from(
    { length: MEILI_WRITE_STREAM_CONSUMER_SLOTS },
    () => redisSearch.duplicate(),
  );
  for (const streamConsumerClient of streamConsumerClients) {
    streamConsumerClient.on('error', (err: any) => {
      if (!streamConsumerStopping) logger.warn({ err }, 'meili: write stream Redis consumer error');
    });
  }

  void (async () => {
    try {
      await ensureMeiliWriteStreamGroup(streamConsumerClients[0]);
      logger.info(
        {
          stream: MEILI_WRITE_STREAM_KEY,
          group: MEILI_WRITE_STREAM_GROUP,
          slots: MEILI_WRITE_STREAM_CONSUMER_SLOTS,
          readCount: MEILI_WRITE_STREAM_READ_COUNT,
          coalesceMs: MEILI_WRITE_STREAM_COALESCE_MS,
          taskChunk: MEILI_WRITE_STREAM_TASK_CHUNK,
        },
        'meili: write stream consumer starting',
      );
      startQueueDepthSamplerIfEnabled();
      for (let slot = 0; slot < MEILI_WRITE_STREAM_CONSUMER_SLOTS; slot += 1) {
        void runMeiliWriteStreamConsumerSlot(streamConsumerClients[slot], slot);
      }
    } catch (err) {
      logger.error({ err }, 'meili: write stream consumer failed to start');
      void stopMeiliWriteStreamConsumer();
    }
  })();
}

async function stopMeiliWriteStreamConsumer() {
  streamConsumerStopping = true;
  streamConsumerStarted = false;
  stopQueueDepthSampler();
  const clientsToClose = streamConsumerClients;
  streamConsumerClients = [];
  await Promise.allSettled(
    clientsToClose.map((clientToClose) => (
      clientToClose.quit().catch(() => clientToClose.disconnect())
    )),
  );
}

// ── Internal HTTP helper ──────────────────────────────────────────────────────

async function meiliFetch(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  if (!MEILI_HTTP_KEEPALIVE_ENABLED || process.env.NODE_ENV === 'test') {
    return meiliFetchWithFetch(path, options);
  }
  return meiliFetchWithKeepAlive(path, options);
}

async function meiliFetchWithFetch(
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

async function meiliFetchWithKeepAlive(
  path: string,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(`${MEILI_HOST}${path}`);
    } catch (err) {
      reject(err);
      return;
    }

    const method = options.method ?? 'GET';
    const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${MEILI_MASTER_KEY}`,
    };
    if (body !== undefined) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const transport = url.protocol === 'https:' ? https : http;
    const agent = url.protocol === 'https:' ? meiliHttpsAgent : meiliHttpAgent;
    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        agent,
      },
      (res: any) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const statusCode = res.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`Meili ${method} ${path} → ${statusCode}: ${text.slice(0, 200)}`));
            return;
          }
          const contentType = String(res.headers?.['content-type'] || '');
          if (!contentType.includes('application/json')) {
            resolve(text);
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.setTimeout(options.timeoutMs ?? MEILI_TIMEOUT_MS, () => {
      req.destroy(new Error(`Meili ${method} ${path} timed out after ${options.timeoutMs ?? MEILI_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
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

  // Match the API's exact search contract. Meili is only a candidate generator,
  // and Postgres recheck requires every query term to survive strict filtering;
  // fuzzy Meili candidates otherwise create expensive false-positive fallbacks.
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/settings/typo-tolerance`, {
    method: 'PATCH',
    body: {
      enabled: false,
    },
    timeoutMs: 5000,
  });

  // Align Meili's tokenization with Postgres websearch_to_tsquery('english', ...).
  // Postgres drops English stop words before building its tsvector; without this,
  // matchingStrategy:'all' fails when the user query contains stop words.
  await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/settings/stop-words`, {
    method: 'PUT',
    body: Array.from(ENGLISH_STOP_WORDS),
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
  const doc = toDoc(msg);
  if (MEILI_WRITE_STREAM_ENABLED) {
    try {
      await enqueueMeiliWriteStream('upsert', doc as unknown as Record<string, unknown>);
      return;
    } catch (err: any) {
      meiliWriteStreamEnqueuedTotal.inc({ op: 'upsert', result: 'error' });
      logger.warn(
        { err: { message: err?.message }, messageId: doc.id },
        'meili: stream enqueue failed; falling back to local batch',
      );
    }
  }
  const previous = pendingUpserts.get(String(doc.id));
  pendingUpserts.set(String(doc.id), {
    doc,
    enqueuedAtMs: previous?.enqueuedAtMs || Date.now(),
  });
  scheduleWriteFlush();
}

async function deleteMessage(id: string): Promise<void> {
  if (!isEnabled()) return;
  const messageId = String(id);
  pendingUpserts.delete(messageId);
  if (MEILI_WRITE_STREAM_ENABLED) {
    try {
      await enqueueMeiliWriteStream('delete', { id: messageId });
      return;
    } catch (err: any) {
      meiliWriteStreamEnqueuedTotal.inc({ op: 'delete', result: 'error' });
      logger.warn(
        { err: { message: err?.message }, messageId },
        'meili: stream delete enqueue failed; falling back to direct delete',
      );
    }
  }
  await deleteMessageNow(messageId, 'delete');
}

async function deleteMessageNow(id: string, op = 'delete'): Promise<void> {
  const t0 = Date.now();
  try {
    await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/documents/${id}`, {
      method: 'DELETE',
    });
    meiliIndexDurationMs.observe({ op }, Date.now() - t0);
  } catch (err: any) {
    meiliIndexFailuresTotal.inc({ op });
    logger.warn({ err: { message: err?.message }, messageId: id }, 'meili: deleteMessage failed');
  }
}

async function batchDeleteMessages(
  ids: string[],
  op = 'delete',
): Promise<{ taskUid?: number } | null> {
  if (!ids.length) return null;
  try {
    const data = await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/documents/delete-batch`, {
      method: 'POST',
      body: ids,
      timeoutMs: Math.max(MEILI_TIMEOUT_MS, 10_000),
    });
    const taskUid = data && typeof data === 'object' && typeof (data as any).taskUid === 'number'
      ? (data as any).taskUid
      : undefined;
    return { taskUid };
  } catch (err: any) {
    meiliIndexFailuresTotal.inc({ op }, ids.length);
    logger.warn(
      { err: { message: err?.message }, messageIds: ids.slice(0, 5), batchSize: ids.length },
      'meili: batch delete failed',
    );
    throw err;
  }
}

async function batchIndexMessages(
  msgs: MeiliMessageDoc[],
): Promise<{ taskUid?: number } | null> {
  if (!msgs.length) return null;
  const data = await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/documents`, {
    method: 'POST',
    body: msgs.map(toDoc),
    timeoutMs: Math.max(MEILI_TIMEOUT_MS, 10_000),
  });
  const taskUid = data && typeof data === 'object' && typeof (data as any).taskUid === 'number'
    ? (data as any).taskUid
    : undefined;
  return { taskUid };
}

// ── Meili task metrics polling ───────────────────────────────────────────────

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

function parseIsoMs(value: any): number | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function schedulePollMeiliTaskMetrics(taskUid: number, op: string): void {
  if (!MEILI_TASK_METRICS_ENABLED) return;
  if (!Number.isFinite(taskUid)) return;
  void pollMeiliTaskMetrics(taskUid, op).catch((err: any) => {
    logger.debug(
      { err: { message: err?.message }, taskUid, op },
      'meili: task metric poll failed',
    );
  });
}

async function pollMeiliTaskMetrics(taskUid: number, op: string): Promise<void> {
  const startedPollAt = Date.now();
  let backoff = MEILI_TASK_METRICS_POLL_MIN_MS;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() - startedPollAt > MEILI_TASK_METRICS_TIMEOUT_MS) return;
    let task: any;
    try {
      task = await meiliFetch(`/tasks/${taskUid}`, { timeoutMs: 3000 });
    } catch {
      // Transient; back off and retry until timeout.
      await new Promise((resolve) => setTimeout(resolve, backoff));
      backoff = Math.min(MEILI_TASK_METRICS_POLL_MAX_MS, backoff * 2);
      continue;
    }
    const status = String(task?.status || '');
    if (TERMINAL_TASK_STATUSES.has(status)) {
      const type = String(task?.type || op || 'unknown');
      const enqueuedMs = parseIsoMs(task?.enqueuedAt);
      const startedMs = parseIsoMs(task?.startedAt);
      const finishedMs = parseIsoMs(task?.finishedAt);
      if (enqueuedMs != null && startedMs != null) {
        meiliTaskWaitMs.observe({ type, status }, Math.max(0, startedMs - enqueuedMs));
      }
      if (startedMs != null && finishedMs != null) {
        meiliTaskDurationMs.observe({ type, status }, Math.max(0, finishedMs - startedMs));
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(MEILI_TASK_METRICS_POLL_MAX_MS, backoff * 2);
  }
}

// ── Queue depth sampler ──────────────────────────────────────────────────────

async function sampleQueueDepth(clientForStream: any): Promise<void> {
  try {
    if (typeof clientForStream?.xlen !== 'function') return;
    const len = await clientForStream.xlen(MEILI_WRITE_STREAM_KEY);
    if (typeof len === 'number' && Number.isFinite(len)) {
      meiliWriteQueueDepth.set(len);
    }
  } catch {
    // Best-effort gauge; missing data is fine.
  }
}

function startQueueDepthSamplerIfEnabled() {
  if (queueDepthTimer) return;
  if (!MEILI_WRITE_STREAM_ENABLED) return;
  if (typeof (redisSearch as any)?.xlen !== 'function') return;
  queueDepthTimer = setInterval(() => {
    void sampleQueueDepth(redisSearch);
  }, MEILI_WRITE_QUEUE_DEPTH_INTERVAL_MS);
  if (typeof queueDepthTimer.unref === 'function') queueDepthTimer.unref();
}

function stopQueueDepthSampler() {
  if (!queueDepthTimer) return;
  clearInterval(queueDepthTimer);
  queueDepthTimer = null;
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
  // Request enough candidates to cover the requested page plus an access-control
  // overfetch buffer. MEILI_CANDIDATE_LIMIT is a ceiling, not a per-query floor:
  // after strict substring filtering was removed, asking Meili for 1000 IDs on
  // every default page became unnecessary tail work.
  const candidateLimit = Math.min(
    MEILI_CANDIDATE_LIMIT,
    Math.max(MEILI_CANDIDATE_MIN_LIMIT, userOffset + userLimit * 5),
  );

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
    q: stripEnglishStopWords(q || ''),
    matchingStrategy: 'all',
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

function incFallbackTotal(reason = 'unknown') {
  meiliSearchFallbackTotal.inc({ reason });
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
  startMeiliWriteStreamConsumerIfEnabled,
  stopMeiliWriteStreamConsumer,
  searchMessageCandidates,
  incFallbackTotal,
  MEILI_INDEX_MESSAGES,
  // Exposed for tests so batching/coalescing/chunking can be exercised
  // without spinning up Redis or a real Meili stream consumer.
  __test: {
    processMeiliWriteStreamMessages,
    flushPendingWrites,
    sampleQueueDepth,
    pollMeiliTaskMetrics,
  },
};
