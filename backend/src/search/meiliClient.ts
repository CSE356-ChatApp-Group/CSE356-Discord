
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
    5000,
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

// ── In-process write batching ────────────────────────────────────────────────

const pendingUpserts = new Map<string, MeiliMessageDoc>();
let writeFlushTimer: NodeJS.Timeout | null = null;
let writeFlushInFlight = false;
let writeFlushQueued = false;
let streamConsumerClients: any[] = [];
let streamConsumerStopping = false;
let streamConsumerStarted = false;

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
  await redisSearch.xadd(
    MEILI_WRITE_STREAM_KEY,
    'MAXLEN',
    '~',
    String(MEILI_WRITE_STREAM_MAXLEN),
    '*',
    'op',
    op,
    'payload',
    JSON.stringify(payload),
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

  const latestByMessageId = new Map<string, { op: 'upsert' | 'delete'; doc?: MeiliMessageDoc }>();
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
    if (op === 'delete') {
      latestByMessageId.set(messageId, { op });
    } else {
      latestByMessageId.set(messageId, { op, doc: toDoc(payload) });
    }
    ackIds.push(entryId);
  }

  const upserts: MeiliMessageDoc[] = [];
  const deletes: string[] = [];
  for (const [id, item] of latestByMessageId) {
    if (item.op === 'delete') {
      deletes.push(id);
    } else if (item.doc) {
      upserts.push(item.doc);
    }
  }

  if (upserts.length) {
    const t0 = Date.now();
    await batchIndexMessages(upserts);
    meiliIndexDurationMs.observe({ op: 'index_stream' }, Date.now() - t0);
    meiliWriteStreamConsumedTotal.inc({ op: 'upsert', result: 'ok' }, upserts.length);
  }
  if (deletes.length) {
    const t0 = Date.now();
    await batchDeleteMessages(deletes, 'delete_stream');
    meiliIndexDurationMs.observe({ op: 'delete_stream' }, Date.now() - t0);
    meiliWriteStreamConsumedTotal.inc({ op: 'delete', result: 'ok' }, deletes.length);
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
        },
        'meili: write stream consumer starting',
      );
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
  const clientsToClose = streamConsumerClients;
  streamConsumerClients = [];
  await Promise.allSettled(
    clientsToClose.map((clientToClose) => (
      clientToClose.quit().catch(() => clientToClose.disconnect())
    )),
  );
}

// ── Query normalisation ───────────────────────────────────────────────────────

// Postgres websearch_to_tsquery('english', ...) silently drops these words
// before building its tsquery.  Sending them to Meili with matchingStrategy:'all'
// means Meili requires terms that the message may not contain literally, producing
// empty-candidate fallbacks for queries that Postgres FTS resolves fine.
// Stripping the same set here keeps the two engines aligned.
const ENGLISH_STOP_WORDS = new Set([
  'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves',
  'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
  'it', 'its', 'itself', 'they', 'them', 'their', 'theirs', 'themselves',
  'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing',
  'a', 'an', 'the', 'and', 'but', 'if', 'or', 'because', 'as',
  'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about',
  'against', 'between', 'into', 'through', 'during', 'before',
  'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in',
  'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'now', 'can', 'will', 'should',
  's', 't', 'd', 'll', 'm', 'o', 're', 've', 'y',
]);

function stripEnglishStopWords(q: string): string {
  const trimmed = q.trim();
  const kept = trimmed.split(/\s+/).filter(
    (tok) => tok.length > 0 && !ENGLISH_STOP_WORDS.has(tok.toLowerCase()),
  );
  return kept.length > 0 ? kept.join(' ') : trimmed;
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
  pendingUpserts.set(String(doc.id), doc);
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

async function batchDeleteMessages(ids: string[], op = 'delete'): Promise<void> {
  if (!ids.length) return;
  try {
    await meiliFetch(`/indexes/${MEILI_INDEX_MESSAGES}/documents/delete-batch`, {
      method: 'POST',
      body: ids,
      timeoutMs: Math.max(MEILI_TIMEOUT_MS, 10_000),
    });
  } catch (err: any) {
    meiliIndexFailuresTotal.inc({ op }, ids.length);
    logger.warn(
      { err: { message: err?.message }, messageIds: ids.slice(0, 5), batchSize: ids.length },
      'meili: batch delete failed',
    );
    throw err;
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
};
