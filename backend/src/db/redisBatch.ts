/**
 * Helpers for Redis commands that accept a variable number of keys/members.
 * Chunking prevents blocking the Redis thread with massive argument arrays,
 * while pipelining batches all chunks into a single network round-trip.
 *
 * Default chunk size is 100. Override per call via the last argument.
 */

const DEFAULT_CHUNK = 100;

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
  const pipeline = client.pipeline();
  for (const c of chunk(keys, chunkSize)) {
    pipeline.unlink(...c);
  }
  await pipeline.exec();
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
  const pipeline = client.pipeline();
  for (const c of chunk(keys, chunkSize)) {
    pipeline.mget(...c);
  }

  const results = await pipeline.exec();
  // pipeline.exec() returns an array of [error, result] pairs
  return results.flatMap(([err, res]: [any, (string | null)[]]) => res);
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
  const pipeline = client.pipeline();
  for (const c of chunk(members, chunkSize)) {
    pipeline.sadd(key, ...c);
  }
  await pipeline.exec();
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
  const pipeline = client.pipeline();
  for (const c of chunk(members, chunkSize)) {
    pipeline.srem(key, ...c);
  }
  await pipeline.exec();
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
  const pipeline = client.pipeline();
  for (const c of chunk(fields, chunkSize)) {
    pipeline.hmget(key, ...c);
  }

  const results = await pipeline.exec();
  return results.flatMap(([err, res]: [any, (string | null)[]]) => res);
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
  const pipeline = client.pipeline();
  for (const c of chunk(members, chunkSize)) {
    // ioredis pipeline allows raw commands via 'call' or standard methods if supported
    pipeline.smismember
      ? pipeline.smismember(key, ...c)
      : pipeline.call("SMISMEMBER", key, ...c);
  }

  const results = await pipeline.exec();
  return results.flatMap(([err, res]: [any, (0 | 1)[]]) => res);
}

module.exports = {
  redisBatchUnlink,
  redisBatchMget,
  redisBatchSadd,
  redisBatchSrem,
  redisBatchHmget,
  redisBatchSmismember,
};
