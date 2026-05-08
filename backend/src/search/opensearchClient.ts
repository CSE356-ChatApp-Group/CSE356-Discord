const logger = require('../utils/logger');
const {
  recordOpenSearchWriteMetric,
  classifyOpenSearchWrite,
} = require('../utils/metrics/openSearchWriteMetrics');

const OPENSEARCH_URL = String(process.env.OPENSEARCH_URL || '').replace(/\/$/, '');
const OPENSEARCH_USERNAME = String(process.env.OPENSEARCH_USERNAME || '');
const OPENSEARCH_PASSWORD = String(process.env.OPENSEARCH_PASSWORD || '');
const OPENSEARCH_INDEX_MESSAGES = String(process.env.OPENSEARCH_INDEX_MESSAGES || 'messages_v1');
/** Single-request timeout (dual-write index/delete/update). Bulk uses an explicit larger timeout. */
const OPENSEARCH_TIMEOUT_MS = Math.min(
  30_000,
  Math.max(500, parseInt(process.env.OPENSEARCH_TIMEOUT_MS || '8000', 10) || 8000),
);

const MESSAGES_V1_INDEX_MAPPING = {
  settings: {
    index: {
      number_of_shards: 3,
      number_of_replicas: 0,
      refresh_interval: '5s',
    },
    analysis: {
      analyzer: {
        default: {
          type: 'standard',
        },
      },
    },
  },
  mappings: {
    dynamic: false,
    properties: {
      id: { type: 'keyword' },
      content: { type: 'text' },
      communityId: { type: 'keyword' },
      channelId: { type: 'keyword' },
      conversationId: { type: 'keyword' },
      authorId: { type: 'keyword' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
      deletedAt: { type: 'date' },
      isDeleted: { type: 'boolean' },
    },
  },
};

function isOpenSearchEnabled(): boolean {
  return Boolean(OPENSEARCH_URL);
}

function opensearchAuthHeader() {
  if (!OPENSEARCH_USERNAME && !OPENSEARCH_PASSWORD) return null;
  const token = Buffer.from(`${OPENSEARCH_USERNAME}:${OPENSEARCH_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

async function opensearchFetch(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    timeoutMs?: number;
    contentType?: string;
    /** For POST /_bulk: number of documents in the batch (metrics). */
    metricDocCount?: number;
    /** When true, success/failure metrics are not recorded here (caller records after parsing /_bulk items). */
    deferWriteMetric?: boolean;
  } = {},
) {
  if (!isOpenSearchEnabled()) {
    throw new Error('OpenSearch is not configured');
  }
  const method = options.method ?? 'GET';
  const writeMeta = classifyOpenSearchWrite(path, method);
  const t0 = Date.now();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? OPENSEARCH_TIMEOUT_MS;
  const tid = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      'Content-Type': options.contentType || 'application/json',
    };
    const auth = opensearchAuthHeader();
    if (auth) headers.Authorization = auth;
    const requestBody =
      typeof options.body === 'string'
        ? options.body
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined;
    const res = await fetch(`${OPENSEARCH_URL}${path}`, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // leave as text
    }
    if (!res.ok) {
      throw new Error(
        `OpenSearch ${method} ${path} -> ${res.status}: ${String(text).slice(0, 250)}`,
      );
    }
    if (writeMeta.record && !options.deferWriteMetric) {
      const docCount =
        writeMeta.operation === 'bulk' ? (options.metricDocCount ?? 0) : undefined;
      recordOpenSearchWriteMetric({
        ms: Date.now() - t0,
        ok: true,
        operation: writeMeta.operation,
        docCount,
      });
    }
    return parsed;
  } catch (err) {
    if (writeMeta.record && !options.deferWriteMetric) {
      recordOpenSearchWriteMetric({
        ms: Date.now() - t0,
        ok: false,
        operation: writeMeta.operation,
      });
    }
    throw err;
  } finally {
    clearTimeout(tid);
  }
}

function toOpenSearchMessageDoc(msg: any) {
  return {
    id: String(msg.id),
    content: String(msg.content || ''),
    communityId: msg.communityId ? String(msg.communityId) : null,
    channelId: msg.channelId ? String(msg.channelId) : null,
    conversationId: msg.conversationId ? String(msg.conversationId) : null,
    authorId: String(msg.authorId),
    createdAt: new Date(msg.createdAt).toISOString(),
    updatedAt: msg.updatedAt ? new Date(msg.updatedAt).toISOString() : null,
    deletedAt: msg.deletedAt ? new Date(msg.deletedAt).toISOString() : null,
    isDeleted: Boolean(msg.deletedAt),
  };
}

async function ensureOpenSearchMessagesIndex(): Promise<void> {
  if (!isOpenSearchEnabled()) return;
  try {
    await opensearchFetch(`/${OPENSEARCH_INDEX_MESSAGES}`, { method: 'HEAD', timeoutMs: 3000 });
  } catch {
    await opensearchFetch(`/${OPENSEARCH_INDEX_MESSAGES}`, {
      method: 'PUT',
      body: MESSAGES_V1_INDEX_MAPPING,
      timeoutMs: 10000,
    });
  }
}

async function bulkIndexMessagesToOpenSearch(messages: any[]): Promise<void> {
  if (!isOpenSearchEnabled() || !messages.length) return;
  const ndjson = messages
    .map((message) => {
      const doc = toOpenSearchMessageDoc(message);
      return `${JSON.stringify({ index: { _index: OPENSEARCH_INDEX_MESSAGES, _id: doc.id } })}\n${JSON.stringify(doc)}`;
    })
    .join('\n') + '\n';
  const timeoutMs = Math.min(120_000, 10_000 + messages.length * 80);
  const t0 = Date.now();
  try {
    const parsed = await opensearchFetch('/_bulk', {
      method: 'POST',
      body: ndjson,
      contentType: 'application/x-ndjson',
      timeoutMs,
      metricDocCount: messages.length,
      deferWriteMetric: true,
    });
    if (parsed && typeof parsed === 'object') {
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      const bad = items.filter((it: any) => {
        const st = it?.index?.status;
        if (st === 200 || st === 201) return false;
        return true;
      });
      if (bad.length) {
        const firstErr = bad.map((it: any) => it?.index?.error || it?.index).find(Boolean);
        logger.warn(
          { batchSize: messages.length, failed: bad.length, firstErr },
          'opensearch: bulk index had per-item failures',
        );
        throw new Error(`OpenSearch bulk: ${bad.length}/${messages.length} items not created (check status/error)`);
      }
    }
    recordOpenSearchWriteMetric({
      ms: Date.now() - t0,
      ok: true,
      operation: 'bulk',
      docCount: messages.length,
    });
  } catch (err: any) {
    logger.warn({ err: { message: err?.message }, batchSize: messages.length }, 'opensearch: bulk index failed');
    recordOpenSearchWriteMetric({
      ms: Date.now() - t0,
      ok: false,
      operation: 'bulk',
    });
    throw err;
  }
}

async function indexMessageToOpenSearch(message: any): Promise<void> {
  if (!isOpenSearchEnabled()) return;
  const doc = toOpenSearchMessageDoc(message);
  await opensearchFetch(`/${OPENSEARCH_INDEX_MESSAGES}/_doc/${doc.id}`, {
    method: 'PUT',
    body: doc,
  });
}

async function tombstoneOrDeleteMessageInOpenSearch(
  messageId: string,
  deletedAt?: string | Date | null,
): Promise<void> {
  if (!isOpenSearchEnabled()) return;
  if (deletedAt) {
    await opensearchFetch(`/${OPENSEARCH_INDEX_MESSAGES}/_update/${messageId}`, {
      method: 'POST',
      body: {
        doc: {
          deletedAt: new Date(deletedAt).toISOString(),
          isDeleted: true,
        },
        doc_as_upsert: false,
      },
    });
    return;
  }
  await opensearchFetch(`/${OPENSEARCH_INDEX_MESSAGES}/_doc/${messageId}`, {
    method: 'DELETE',
  });
}

module.exports = {
  OPENSEARCH_INDEX_MESSAGES,
  MESSAGES_V1_INDEX_MAPPING,
  isOpenSearchEnabled,
  opensearchFetch,
  ensureOpenSearchMessagesIndex,
  bulkIndexMessagesToOpenSearch,
  indexMessageToOpenSearch,
  tombstoneOrDeleteMessageInOpenSearch,
};
