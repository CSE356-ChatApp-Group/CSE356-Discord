/**
 * Helpers for Redis commands that accept a variable number of keys/members.
 * In cluster mode, multi-key commands (MGET, UNLINK key1 key2 …) are only
 * valid when every key maps to the same hash slot. Since callers pass
 * arbitrary keys, we always use per-key commands in a single pipeline so
 * the cluster client can route each command to the correct shard while
 * still batching the round-trips.
 *
 * The chunkSize parameter is kept for API compatibility but is no longer used
 * for MGET / UNLINK (individual commands need no chunking).
 */

const DEFAULT_CHUNK = 100;

function normalizeChunkSize(chunkSize: number): number {
  const n = Number(chunkSize);
  if (!Number.isFinite(n)) return DEFAULT_CHUNK;
  return Math.max(1, Math.floor(n));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/**
 * Bulk-delete keys using UNLINK (one command per key so cluster routing works).
 */
async function redisBatchUnlink(
  client: any,
  keys: string[],
  _chunkSize = DEFAULT_CHUNK,
): Promise<void> {
  if (!keys.length) return;
  const pipeline = client.pipeline();
  for (const key of keys) {
    pipeline.unlink(key);
  }
  const results = await pipeline.exec();
  for (const [err] of results) {
    if (err) throw err;
  }
}

/**
 * Batch GET across many keys. Returns values in the same order as `keys`.
 * Uses individual GET commands so cross-slot keys work in cluster mode.
 */
async function redisBatchMget(
  client: any,
  keys: string[],
  _chunkSize = DEFAULT_CHUNK,
): Promise<(string | null)[]> {
  if (!keys.length) return [];
  const pipeline = client.pipeline();
  for (const key of keys) {
    pipeline.get(key);
  }
  const results = await pipeline.exec();
  const out: (string | null)[] = [];
  for (const [err, value] of results) {
    if (err) throw err;
    out.push(typeof value === 'string' ? value : null);
  }
  return out;
}

/**
 * Batch SADD — adds many members to a single key.
 */
async function redisBatchSadd(
  client: any,
  key: string,
  members: string[],
  chunkSize = DEFAULT_CHUNK,
): Promise<void> {
  if (!members.length) return;
  const size = normalizeChunkSize(chunkSize);
  const pipeline = client.pipeline();
  for (const c of chunk(members, size)) {
    pipeline.sadd(key, ...c);
  }
  const results = await pipeline.exec();
  for (const [err] of results) {
    if (err) throw err;
  }
}

/**
 * Batch SREM — removes many members from a single key.
 */
async function redisBatchSrem(
  client: any,
  key: string,
  members: string[],
  chunkSize = DEFAULT_CHUNK,
): Promise<void> {
  if (!members.length) return;
  const size = normalizeChunkSize(chunkSize);
  const pipeline = client.pipeline();
  for (const c of chunk(members, size)) {
    pipeline.srem(key, ...c);
  }
  const results = await pipeline.exec();
  for (const [err] of results) {
    if (err) throw err;
  }
}

/**
 * Batch HMGET — reads many fields from a single hash. Returns values in field order.
 */
async function redisBatchHmget(
  client: any,
  key: string,
  fields: string[],
  chunkSize = DEFAULT_CHUNK,
): Promise<(string | null)[]> {
  if (!fields.length) return [];
  const size = normalizeChunkSize(chunkSize);
  const fieldChunks = chunk(fields, size);
  const pipeline = client.pipeline();
  for (const c of fieldChunks) {
    pipeline.hmget(key, ...c);
  }

  const results = await pipeline.exec();
  const out: (string | null)[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const [err, res] = results[i];
    if (err) throw err;
    if (!Array.isArray(res) || res.length !== fieldChunks[i].length) {
      throw new Error('redisBatchHmget: unexpected pipeline result shape');
    }
    out.push(...res);
  }
  return out;
}

/**
 * Batch SMISMEMBER — checks set membership for many members. Returns a 0/1 array.
 */
async function redisBatchSmismember(
  client: any,
  key: string,
  members: string[],
  chunkSize = DEFAULT_CHUNK,
): Promise<(0 | 1)[]> {
  if (!members.length) return [];
  const size = normalizeChunkSize(chunkSize);
  const memberChunks = chunk(members, size);
  const pipeline = client.pipeline();
  for (const c of memberChunks) {
    // ioredis pipeline allows raw commands via 'call' or standard methods if supported
    pipeline.smismember
      ? pipeline.smismember(key, ...c)
      : pipeline.call("SMISMEMBER", key, ...c);
  }

  const results = await pipeline.exec();
  const out: (0 | 1)[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const [err, res] = results[i];
    if (err) throw err;
    if (!Array.isArray(res) || res.length !== memberChunks[i].length) {
      throw new Error('redisBatchSmismember: unexpected pipeline result shape');
    }
    for (const value of res) {
      out.push(Number(value) === 1 ? 1 : 0);
    }
  }
  return out;
}

module.exports = {
  redisBatchUnlink,
  redisBatchMget,
  redisBatchSadd,
  redisBatchSrem,
  redisBatchHmget,
  redisBatchSmismember,
};
