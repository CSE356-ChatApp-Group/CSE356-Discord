const {
  getJsonCache,
  setJsonCacheWithStale,
  staleCacheKey,
  withDistributedSingleflight,
} = require('../src/utils/distributedSingleflight');

function makeRedisMock() {
  const store = new Map<string, string>();
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (...args: any[]) => {
      const [key, value, mode, ttlMode, ttlVal] = args;
      if (mode === 'NX') {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      if (ttlMode === 'EX' && typeof ttlVal === 'number') {
        store.set(key, value);
        return 'OK';
      }
      store.set(key, value);
      return 'OK';
    }),
    setex: jest.fn(async (key: string, _ttl: number, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => {
      let deleted = 0;
      for (const key of keys) {
        if (store.delete(key)) deleted += 1;
      }
      return deleted;
    }),
    eval: jest.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  };
}

describe('distributedSingleflight util', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dedupes same-process concurrent loads', async () => {
    const redis = makeRedisMock();
    const inflight = new Map<string, Promise<any>>();
    let loads = 0;

    const run = () => withDistributedSingleflight({
      redis,
      cacheKey: 'k1',
      inflight,
      readFresh: async () => null,
      readStale: async () => null,
      load: async () => {
        loads += 1;
        return { ok: true };
      },
    });

    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(loads).toBe(1);
  });

  it('returns stale immediately when another instance holds lock', async () => {
    const redis = makeRedisMock();
    const inflight = new Map<string, Promise<any>>();
    redis.store.set('sf:lock:k2', 'other-node');
    redis.store.set(staleCacheKey('k2'), JSON.stringify({ stale: true }));

    const load = jest.fn(async () => ({ fresh: true }));
    const result = await withDistributedSingleflight({
      redis,
      cacheKey: 'k2',
      inflight,
      readFresh: async () => getJsonCache(redis, 'k2'),
      readStale: async () => getJsonCache(redis, staleCacheKey('k2')),
      load,
    });

    expect(result).toEqual({ stale: true });
    expect(load).not.toHaveBeenCalled();
  });

  it('writes both fresh and stale cache entries', async () => {
    const redis = makeRedisMock();
    await setJsonCacheWithStale(redis, 'k3', { value: 1 }, 15, { jitterRatio: 0 });

    expect(await getJsonCache(redis, 'k3')).toEqual({ value: 1 });
    expect(await getJsonCache(redis, staleCacheKey('k3'))).toEqual({ value: 1 });
  });

  it('writeStale:false skips stale companion key', async () => {
    const redis = makeRedisMock();
    await setJsonCacheWithStale(redis, 'k4', { value: 2 }, 10, { writeStale: false, jitterRatio: 0 });
    expect(await getJsonCache(redis, 'k4')).toEqual({ value: 2 });
    expect(await getJsonCache(redis, staleCacheKey('k4'))).toBeNull();
  });
});
