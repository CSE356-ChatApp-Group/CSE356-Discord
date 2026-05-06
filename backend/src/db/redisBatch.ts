/**
 * Helpers for Redis commands that accept a variable number of keys/members.
 * Chunking prevents blocking the Redis thread with massive argument arrays,
 * while pipelining batches all chunks into a single network round-trip.
 *
 * Default chunk size is 100. Override per call via the last argument.
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
 * Bulk-delete keys using UNLINK.
 */
async function redisBatchUnlink(
  client: any,
  keys: string[],
  chunkSize = DEFAULT_CHUNK,
): Promise<void> {
  if (!keys.length) return;
  const size = normalizeChunkSize(chunkSize);
  const pipeline = client.pipeline();
  for (const c of chunk(keys, size)) {
    pipeline.unlink(...c);
  }
  const results = await pipeline.exec();
  for (const [err] of results) {
    if (err) throw err;
  }
}

/**
 * Batch MGET across many keys. Returns values in the same order as `keys`.
 */
async function redisBatchMget(
  client: any,
  keys: string[],
  chunkSize = DEFAULT_CHUNK,
): Promise<(string | null)[]> {
  if (!keys.length) return [];
  const size = normalizeChunkSize(chunkSize);
  const keyChunks = chunk(keys, size);
  const pipeline = client.pipeline();
  for (const c of keyChunks) {
    pipeline.mget(...c);
  }

  const results = await pipeline.exec();
  const out: (string | null)[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const [err, res] = results[i];
    if (err) throw err;
    if (!Array.isArray(res) || res.length !== keyChunks[i].length) {
      throw new Error('redisBatchMget: unexpected pipeline result shape');
    }
    out.push(...res);
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
